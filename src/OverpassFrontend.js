var async = require('async')
var weightSort = require('weight-sort')
var BoundingBox = require('boundingbox')

var httpLoad = require('./httpLoad')
var removeNullEntries = require('./removeNullEntries')

var OverpassObject = require('./OverpassObject')
var OverpassNode = require('./OverpassNode')
var OverpassWay = require('./OverpassWay')
var OverpassRelation = require('./OverpassRelation')
var RequestGet = require('./RequestGet')
var RequestBBox = require('./RequestBBox')
var defines = require('./defines')

class OverpassFrontend {
  constructor (url, options) {
    this.url = url
    this.options = {
      effortPerRequest: 1000,
      effortNode: 1,
      effortWay: 4,
      effortRelation: 64,
      timeGap: 10
    }
    for (var k in options) {
      this.options[k] = options[k]
    }

    this.cacheElements = {}
    this.cacheElementsMemberOf = {}
    this.cacheBBoxQueries = {}

    this.requests = []
    this.requestIsActive = false
    this.errorCount = 0
  }

  /**
   * @param {string|string[]} ids - Id or array of Ids of OSM map features
   * @param {object} options
   * @param {number} [options.priority=0] - Priority for loading these objects. The lower the sooner they will be requested.
   * @param {boolean} [options.sort=false] - When set to true, the function featureCallback will be called in some particular order
   * @param {function} featureCallback Will be called for each object in the order of the IDs in parameter 'ids'. Will be passed: 1. err (if an error occured, otherwise null), 2. the object or null.
   * @param {function} finalCallback Will be called after the last feature. Will be passed: 1. err (if an error occured, otherwise null).
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
    if (this.requestIsActive) {
      return
    }

    // preprocess all requests
    // e.g. call featureCallback for elements which were received in the
    // meantime
    this.requests.forEach(request => {
      if (request) {
        request.preprocess()

        if (request.mayFinish()) {
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
    if (!err && results.remark) {
      err = results.remark
    }

    if (err) {
      this.errorCount++
      this.requestIsActive = false

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

          if (request.mayFinish()) {
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

      var ob = this.createOrUpdateOSMObject(el, part)

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
      if (!request.aborted && part.featureCallback) {
        part.featureCallback(err, ob)
      }
    }

    for (var id in context.todo) {
      if (!(id in this.cacheElements)) {
        this.cacheElements[id] = null
      }
    }

    request.finishSubRequest(subRequest)

    this._next()
  }

  /**
   * @param {string} query - Query for requesting objects from Overpass API, e.g. "node[amenity=restaurant]"
   * @param {L.latLngBounds} bounds - A Leaflet Bounds object, e.g. from map.getBounds()
   * @param {object} options
   * @param {number} [options.priority=0] - Priority for loading these objects. The lower the sooner they will be requested.
   * @param {boolean} [options.sort=false] - When set to true, the function featureCallback will be called in some particular order
   * @param {function} featureCallback Will be called for each object in the order of the IDs in parameter 'ids'. Will be passed: 1. err (if an error occured, otherwise null), 2. the object or null.
   * @param {function} finalCallback Will be called after the last feature. Will be passed: 1. err (if an error occured, otherwise null).
   */
  BBoxQuery (query, bounds, options, featureCallback, finalCallback) {
    bounds = new BoundingBox(bounds)

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
    delete this.cacheBBoxQueries[query]
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
    this.requestIsActive = false

    async.setImmediate(function () {
      this._overpassProcess()
    }.bind(this))
  }

  abortAllRequests () {
    for (var j = 0; j < this.requests.length; j++) {
      if (this.requests[j] === null) {
        continue
      }

      this.requests[j].finalCallback('abort')
    }

    this.requests = []
  }

  removeFromCache (ids) {
    if (typeof ids === 'string') {
      ids = [ ids ]
    }

    for (var i = 0; i < ids.length; i++) {
      delete this.cacheElements[ids[i]]
    }
  }

  createOrUpdateOSMObject (el, options) {
    var id = el.type.substr(0, 1) + el.id
    var ob = null

    if (id in this.cacheElements && this.cacheElements[id]) {
      ob = this.cacheElements[id]
    } else if (el.type === 'relation') {
      ob = new OverpassRelation(id)
    } else if (el.type === 'way') {
      ob = new OverpassWay(id)
    } else if (el.type === 'node') {
      ob = new OverpassNode(id)
    } else {
      ob = new OverpassObject(id)
    }

    ob.updateData(el, options)

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

module.exports = OverpassFrontend
