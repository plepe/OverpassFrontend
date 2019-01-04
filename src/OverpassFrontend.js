const ee = require('event-emitter')
var async = require('async')
var weightSort = require('weight-sort')
var BoundingBox = require('boundingbox')
const LokiJS = require('lokijs')

var httpLoad = require('./httpLoad')
var removeNullEntries = require('./removeNullEntries')

var OverpassObject = require('./OverpassObject')
var OverpassNode = require('./OverpassNode')
var OverpassWay = require('./OverpassWay')
var OverpassRelation = require('./OverpassRelation')
var RequestGet = require('./RequestGet')
var RequestBBox = require('./RequestBBox')
var defines = require('./defines')
var loadOsmFile = require('./loadOsmFile')
var copyOsm3sMetaFrom = require('./copyOsm3sMeta')
const Filter = require('./Filter')

/**
 * An error occured
 * @event OverpassFrontend#error
 * @param {Error} error
 */

/**
 * When a file is specified as URL, this event notifies, that the file has been completely loaded. When a Overpass API is used, every time when data has been received.
 * @event OverpassFrontend#load
 * @param {object} osm3sMeta Meta data (not all properties of meta data might be set)
 * @param {number} osm3sMeta.version OpenStreetMap API version (currently 0.6)
 * @param {string} osm3sMeta.generator Data generator
 * @param {string} osm3sMeta.timestamp_osm_base RFC8601 timestamp of OpenStreetMap data
 * @param {string} osm3sMeta.copyright Copyright statement
 */

/**
 * When an object is updated (e.g. when loaded; additional information loaded; when a member object got loaded)
 * @event OverpassFrontend#update
 * @param {OverpassNode|OverpassWay|OverpassRelation} object The object which got updated.
 */

/**
 * A connection to an Overpass API Server or an OpenStreetMap file
 * @param {string} url The URL of the API, e.g. 'https://overpass-api.de/api/'. If you omit the protocol, it will use the protocol which is in use for the current page (or https: on nodejs): '//overpass-api.de/api/'. If the url ends in .json, .osm or .osm.bz2 it will load this OpenStreetMap file and use the data from there.
 * @param {object} options Options
 * @param {number} [options.effortPerRequest=1000] To avoid huge requests to the Overpass API, the request will be split into smaller chunks. This value defines, at which effort the request will be sent.
 * @param {number} [options.effortNode=1] The effort for request a node. Default: 1.
 * @param {number} [options.effortWay=4] The effort for request a way.
 * @param {number} [options.effortRelation=64] The effort for request a relation.
 * @param {number} [options.timeGap=10] A short time gap between two requests to the Overpass API (milliseconds).
 * @param {number} [options.loadChunkSize=1000] When loading a file (instead connecting to an Overpass URL) load elements in chunks of n items.
 */
class OverpassFrontend {
  constructor (url, options) {
    this.url = url
    this.options = {
      effortPerRequest: 1000,
      effortNode: 1,
      effortWay: 4,
      effortRelation: 64,
      timeGap: 10,
      loadChunkSize: 1000
    }
    for (var k in options) {
      this.options[k] = options[k]
    }

    let db = new LokiJS()
    this.db = db.addCollection('osm', { unique: [ 'id' ] })

    this.clearCache()

    this.requests = []
    this.requestIsActive = false
    this.errorCount = 0

    this.pendingNotifyMemberUpdate = {}
    this.pendingUpdateEmit = {}

    if (this.url.match(/\.(json|osm\.bz2|osm)$/)) {
      this.localOnly = true
      this.ready = false
      this._loadFile()
    } else {
      this.remote = true
      this.ready = true
    }
  }

  /**
   * clear all caches
   */
  clearCache () {
    this.cacheElements = {}
    this.cacheElementsMemberOf = {}
    this.cacheBBoxQueries = {}
    this.db.clear()
  }

  _loadFile () {
    let osm3sMeta

    loadOsmFile(this.url,
      (err, result) => {
        if (err) {
          console.log('Error loading file', err)
          return this.emit('error', err)
        }

        osm3sMeta = copyOsm3sMetaFrom(result)

        let chunks = []
        for (var i = 0; i < result.elements.length; i += this.options.loadChunkSize) {
          chunks.push(result.elements.slice(i, i + this.options.loadChunkSize))
        }

        async.eachLimit(
          chunks,
          1,
          (chunk, done) => {
            chunk.forEach(
              (element) => {
                let ob = this.createOrUpdateOSMObject(element, {
                  osm3sMeta,
                  properties: OverpassFrontend.TAGS | OverpassFrontend.META | OverpassFrontend.MEMBERS
                })

                // Set objects to fully known, as no more data can be loaded from the file
                ob.properties |= OverpassFrontend.ALL
              }
            )

            global.setTimeout(done, 0)
          },
          (err) => {
            this.pendingNotifies()

            if (err) {
              console.log('Error loading file', err)
              return this.emit('error', err)
            }

            this.emit('load', osm3sMeta)

            this.ready = true
            this._overpassProcess()
          }
        )
      }
    )
  }

  /**
   * @param {string|string[]} ids - Id or array of Ids of OSM map features, e.g. [ 'n123', 'w2345', 'n123' ]. Illegal IDs will not produce an error but generate a 'null' object.
   * @param {object} options Various options, see below
   * @param {number} [options.priority=0] - Priority for loading these objects. The lower the sooner they will be requested.
   * @param {string|boolean} [options.sort=false] - When set to true or "index", the function featureCallback will be called in order of the "ids" array. When set to false or null, the featureCallback will be called as soon as the object is loaded (e.g. immediately, if it is cached). When set to "BBoxDiagonalLength", the objects are ordered by the length of the diagonal of the bounding box.
   * @param {"asc"|"desc"} [options.sortDir="asc"] Sort direction.
   * @param {function} featureCallback Will be called for each object which is passed in parameter 'ids'. Will be passed: 1. err (if an error occured, otherwise null), 2. the object or null, 3. index of the item in parameter ids.
   * @param {function} finalCallback Will be called after the last feature. Will be passed: 1. err (if an error occured, otherwise null).
   * @return {RequestGet}
   */
  get (ids, options, featureCallback, finalCallback) {
    var request = new RequestGet(this, {
      ids: ids,
      options: options,
      featureCallback: featureCallback,
      finalCallback: finalCallback
    })

    this.requests.push(request)

    this._next()

    return request
  }

  /**
   * return an OSM object, if it is already in the cache
   * @param {string} id - Id of an OSM map feature
   * @param {object} options
   * @param {int} [options.properties] - Which properties have to be known (default: OverpassFrontend.DEFAULT)
   * @return {null|false|OverpassObject} - null: does not exist in the database; false: may exist, but has not been loaded yet (or not enough properties known); OverpassObject: sucessful object
   */
  getCached (id, options) {
    if (typeof options === 'undefined') {
      options = {}
    }

    if (typeof options.properties === 'undefined') {
      options.properties = defines.DEFAULT
    }

    if (!(id in this.cacheElements)) {
      return false
    }

    let ob = this.cacheElements[id]

    if (ob.missingObject) {
      return null
    }

    if ((options.properties & ob.properties) !== options.properties) {
      return false
    }

    return ob
  }

  /**
   * Current request context
   * @typedef {Object} OverpassFrontend#Context
   * @property {string} query - The compiled code of all sub requests
   * @property {Request[]} requests - List of all requests in the context
   * @property {Request#SubRequest[]} subRequests - List of all subRequests in the context
   * @property {BoundingBox} bbox - when there are any BBox requests, add this global bbox
   * @property {int} maxEffort - how many queries can we still add to this context
   * @property {object} todo - list of items which should be loaded via get requests to avoid duplicates
   */

  _overpassProcess () {
    // currently active - we'll come back later :-)
    if (this.requestIsActive || !this.ready) {
      return
    }

    // preprocess all requests
    // e.g. call featureCallback for elements which were received in the
    // meantime
    this.requests.forEach(request => {
      if (request) {
        request.preprocess()

        if (request.mayFinish() || this.localOnly) {
          request.finish()
        }
      }
    })
    this.requests = removeNullEntries(this.requests)

    // nothing todo ...
    if (!this.requests.length) {
      return
    }

    // now order all requests by priority
    this.requests = weightSort(this.requests, 'priority')

    this.requestIsActive = true
    var request
    var j

    var context = {
      bbox: null,
      todo: {},
      requests: [],
      subRequests: [],
      query: '',
      minPriority: this.requests[0].priority,
      minEffort: 0,
      maxEffort: 0
    }

    for (j = 0; j < this.requests.length; j++) {
      request = this.requests[j]

      if (request.priority > context.minPriority &&
         (context.maxEffort === null || context.maxEffort > this.options.effortPerRequest)) {
        break
      }

      if (request.willInclude(context)) {
        let { minEffort, maxEffort } = request.minMaxEffort()

        if (context.minEffort > 0 && context.minEffort + minEffort > this.options.effortPerRequest) {
          continue
        }

        context.minEffort += minEffort
        if (maxEffort === null) {
          context.maxEffort = null
        } else if (context.maxEffort !== null) {
          context.maxEffort += maxEffort
        }

        context.requests.push(request)
      }
    }

    var effortAvailable = this.options.effortPerRequest

    for (j = 0; j < context.requests.length; j++) {
      request = context.requests[j]
      let remainingRequestsAtPriority = context.requests.slice(j).filter(r => r.priority === request.priority)
      context.maxEffort = Math.ceil(effortAvailable / remainingRequestsAtPriority.length)
      var subRequest = request.compileQuery(context)

      if (subRequest.parts.length === 0) {
        console.log('subRequest has no parts! Why was willInclude true?', subRequest)
        continue
      }

      context.subRequests.push(subRequest)

      if (context.query !== '') {
        context.query += '\nout count;\n'
      }

      effortAvailable -= subRequest.effort
      context.query += subRequest.query

      if (effortAvailable <= 0) {
        break
      }
    }

    if (context.query === '') {
      return this._next()
    }

    var query = '[out:json]'
    if (context.bbox) {
      query += '[bbox:' + context.bbox.toLatLonString() + ']'
    }

    query += ';\n' + context.query

    setTimeout(function () {
      httpLoad(
        this.url,
        null,
        query,
        this._handleResult.bind(this, context)
      )
    }.bind(this), this.options.timeGap)
  }

  _handleResult (context, err, results) {
    this.requestIsActive = false

    if (err === null && results.remark) {
      err = results.remark
    }

    if (err !== null) {
      this.errorCount++

      if (this.errorCount <= 3) {
        // retry
        this._overpassProcess()
      } else {
        // abort
        // call finalCallback for the request
        context.subRequests.forEach(function (subRequest) {
          subRequest.request.finish(err)
        })
      }

      return
    } else {
      this.errorCount = 0
    }

    let osm3sMeta = copyOsm3sMetaFrom(results)
    this.emit('load', osm3sMeta)

    var subRequestsIndex = 0
    var partIndex = 0
    var subRequest = context.subRequests[0]
    var request = subRequest.request
    var part = subRequest.parts[0]
    if (!('count' in part)) {
      part.count = 0
    }

    for (var i = 0; i < results.elements.length; i++) {
      var el = results.elements[i]

      if (isSeparator(el)) {
        partIndex++

        if (partIndex >= subRequest.parts.length) {
          request.finishSubRequest(subRequest)

          if (request.mayFinish() && !request.finished) {
            request.finish()
          }

          subRequestsIndex++
          partIndex = 0
          subRequest = context.subRequests[subRequestsIndex]
          request = subRequest.request
          part = subRequest.parts[0]
          if (!('count' in part)) {
            part.count = 0
          }
        } else {
          part = subRequest.parts[partIndex]
        }

        continue
      }

      part.osm3sMeta = osm3sMeta
      var ob = this.createOrUpdateOSMObject(el, part)
      delete context.todo[ob.id]

      var members = this.cacheElements[ob.id].memberIds()
      if (members) {
        for (var j = 0; j < members.length; j++) {
          if (!(members[j] in this.cacheElementsMemberOf)) {
            this.cacheElementsMemberOf[members[j]] = [ this.cacheElements[ob.id] ]
          } else {
            this.cacheElementsMemberOf[members[j]].push(this.cacheElements[ob.id])
          }
        }
      }

      part.count++
      if (part.receiveObject) {
        part.receiveObject(ob)
      }
      if (!request.aborted && !request.finished && part.featureCallback) {
        part.featureCallback(err, ob)
      }
    }

    if (!(subRequestsIndex === context.subRequests.length - 1 || partIndex === context.subRequests[subRequestsIndex].parts.length - 1)) {
      console.log('too many parts!!!!')
    }

    for (var id in context.todo) {
      if (!(id in this.cacheElements)) {
        let ob = new OverpassObject()
        ob.id = id
        ob.type = { n: 'node', w: 'way', r: 'relation' }[id.substr(0, 1)]
        ob.osm_id = id.substr(1)
        ob.properties = OverpassFrontend.ALL
        ob.missingObject = true
        this.cacheElements[id] = ob
        this.db.insert(ob.dbInsert())
      } else {
        let ob = this.cacheElements[id]
        ob.missingObject = true
        this.db.update(ob.dbInsert())
      }
    }

    this.pendingNotifies()

    request.finishSubRequest(subRequest)

    this._next()
  }

  /**
   * @param {string} query - Query for requesting objects from Overpass API, e.g. "node[amenity=restaurant]" or "(node[amenity];way[highway~'^(primary|secondary)$];)". See <a href='Filter.html'>Filter</a> for details.
   * @param {BoundingBox} bounds - A Leaflet Bounds object, e.g. from map.getBounds()
   * @param {object} options
   * @param {number} [options.priority=0] - Priority for loading these objects. The lower the sooner they will be requested.
   * @param {boolean|string} [options.sort=false] - If false, it will be called as soon as the features are availabe (e.g. immediately when cached).
   * @param {bit_array} [options.properties] Which properties of the features should be downloaded: OVERPASS_ID_ONLY, OVERPASS_BBOX, OVERPASS_TAGS, OVERPASS_GEOM, OVERPASS_META. Combine by binary OR: ``OVERPASS_ID | OVERPASS_BBOX``. Default: OverpassFrontend.TAGS | OverpassFrontend.MEMBERS | OverpassFrontend.BBOX
   * @param {number} [options.split=0] If more than 'split' elements would be returned, split into several smaller requests, with 'split' elements each. Default: 0 (do not split)
   * @param {boolean} [options.members=false] Query relation members of. Default: false
   * @param {function} [options.memberCallback] For every member, call this callback function. (Requires options.members=true)
   * @param {bit_array} [options.memberProperties] Which properties should be loaded for the members. Default: OverpassFrontend.TAGS | OverpassFrontend.MEMBERS | OverpassFrontend.BBOX
   * @param {number} [options.memberSplit=0] If more than 'memberSplit' member elements would be returned, split into smaller requests (see 'split'). 0 = do not split.
   * @param {string|Filter} [options.filter] Additional filter.
   * @param {boolean} [options.noCacheQuery=false] If true, the local cache will not be queried
   * @param {function} featureCallback Will be called for each matching object. Will be passed: 1. err (if an error occured, otherwise null), 2. the object or null.
   * @param {function} finalCallback Will be called after the last feature. Will be passed: 1. err (if an error occured, otherwise null).
   * @return {RequestBBox}
   */
  BBoxQuery (query, bounds, options, featureCallback, finalCallback) {
    if (bounds) {
      bounds = new BoundingBox(bounds)
    }

    var request = new RequestBBox(this, {
      query: query,
      bounds: bounds,
      remainingBounds: bounds,
      options: options,
      doneFeatures: {},
      featureCallback: featureCallback,
      finalCallback: finalCallback
    })

    this.requests.push(request)

    this._next()

    return request
  }

  clearBBoxQuery (query) {
    let filterId = new Filter(query).toString()

    delete this.cacheBBoxQueries[filterId]
  }

  _abortRequest (request) {
    var p = this.requests.indexOf(request)

    if (p === -1) {
      return
    }

    this.requests[p] = null
  }

  _finishRequest (request) {
    this.requests[this.requests.indexOf(request)] = null
  }

  _next () {
    async.setImmediate(function () {
      this._overpassProcess()
    }.bind(this))
  }

  abortAllRequests () {
    for (var j = 0; j < this.requests.length; j++) {
      if (this.requests[j] === null) {
        continue
      }

      this.requests[j].abort()
    }

    this.requests = []
  }

  removeFromCache (ids) {
    if (typeof ids === 'string') {
      ids = [ ids ]
    }

    for (var i = 0; i < ids.length; i++) {
      if (ids[i] in this.cacheElements) {
        let ob = this.cacheElements[ids[i]]

        // remove all memberOf references
        if (ob.members) {
          ob.members.forEach(member => {
            let memberOb = this.cacheElements[member.id]
            memberOb.memberOf = memberOb.memberOf
              .filter(memberOf => memberOf.id !== ob.id)
          })
        }

        let lokiOb = this.cacheElements[ids[i]].dbData
        delete this.cacheElements[ids[i]]
        this.db.remove(lokiOb)
      }
    }
  }

  notifyMemberUpdates () {
    let todo = this.pendingNotifyMemberUpdate
    this.pendingNotifyMemberUpdate = {}

    for (var k in todo) {
      let ob = this.cacheElements[k]
      ob.notifyMemberUpdate(todo[k])

      this.pendingUpdateEmit[ob.id] = ob
    }
  }

  pendingNotifies () {
    this.notifyMemberUpdates()

    let todo = Object.values(this.pendingUpdateEmit)
    this.pendingUpdateEmit = {}

    todo.forEach(ob => {
      ob.emit('update', ob)
      this.db.update(ob.dbInsert())
    })
  }

  createOrUpdateOSMObject (el, options) {
    var id = el.type.substr(0, 1) + el.id
    var ob = null
    let create = true

    if (id in this.cacheElements && !this.cacheElements[id]) {
      console.log('why can this be null?', id)
    }

    if (id in this.cacheElements && this.cacheElements[id]) {
      ob = this.cacheElements[id]
      create = false

      // no new information -> return
      if (~ob.properties & options.properties === 0) {
        return ob
      }
    } else if (el.type === 'relation') {
      ob = new OverpassRelation(id)
    } else if (el.type === 'way') {
      ob = new OverpassWay(id)
    } else if (el.type === 'node') {
      ob = new OverpassNode(id)
    } else {
      ob = new OverpassObject(id)
    }

    ob.overpass = this
    ob.updateData(el, options)

    ob.memberOf.forEach(entry => {
      if (entry.id in this.pendingNotifyMemberUpdate) {
        this.pendingNotifyMemberUpdate[entry.id].push(ob)
      } else {
        this.pendingNotifyMemberUpdate[entry.id] = [ ob ]
      }
    })
    this.pendingUpdateEmit[ob.id] = ob

    if (create) {
      this.db.insert(ob.dbInsert())
    } else {
      this.db.update(ob.dbInsert())
    }

    this.cacheElements[id] = ob
    return ob
  }

  regexpEscape (str) {
    return str.replace('\\', '\\\\')
         .replace('.', '\\.')
         .replace('|', '\\|')
         .replace('[', '\\[')
         .replace(']', '\\]')
         .replace('(', '\\(')
         .replace(')', '\\)')
         .replace('{', '\\{')
         .replace('}', '\\}')
         .replace('?', '\\?')
         .replace('+', '\\+')
         .replace('*', '\\*')
         .replace('^', '\\^')
         .replace('$', '\\$')
  }
}

for (var k in defines) {
  OverpassFrontend[k] = defines[k]
}

function isSeparator (el) {
  return ('count' in el || ('type' in el && el.type === 'count'))
}

ee(OverpassFrontend.prototype)

module.exports = OverpassFrontend
