const Request = require('./Request')
const defines = require('./defines')
const BoundingBox = require('boundingbox')
const overpassOutOptions = require('./overpassOutOptions')

/**
 * A get request (request list of map features by id)
 * @extends Request
 */
class RequestGet extends Request {
  /**
   * @param {OverpassFrontend} overpass
   * @param {data} data
   */
  constructor (overpass, data) {
    super(overpass, data)
    this.type = 'get'

    if (typeof this.ids === 'string') {
      this.ids = [ this.ids ]
    } else {
      this.ids = this.ids.concat()
    }

    if (typeof this.options.properties === 'undefined') {
      this.options.properties = defines.DEFAULT
    }

    for (var i = 0; i < this.ids.length; i++) {
      if (this.ids[i] in this.overpass.cacheElements && this.overpass.cacheElements[this.ids[i]] === false) {
        delete this.overpass.cacheElements[this.ids[i]]
      }
    }

    if (this.options.bbox) {
      this.options.bbox = new BoundingBox(this.options.bbox)
    }
    // option 'split' not available for get requests -> use effort instead
    delete this.options.split

    this.done = {}
  }

  /**
   * check if there are any map features which can be returned right now
   */
  preprocess () {
    this.allFound = true

    for (var i = 0; i < this.ids.length; i++) {
      var id = this.ids[i]

      if (id === null) {
        continue
      }

      if (id in this.overpass.cacheElements) {
        var ob = this.overpass.cacheElements[id]
        var ready = true

        // Feature does not exists!
        if (ob === null) {
          this.featureCallback(null, null, i)
          this.ids[i] = null
          continue
        }

        // for bbox option, if object is (partly) loaded, but outside call
        // featureCallback with 'false'
        if (this.options.bbox && !ob.intersects(this.options.bbox)) {
          this.featureCallback(null, false, i)
          this.ids[i] = null
          continue
        }

        // not fully loaded
        if ((ob !== false && ob !== null) && (this.options.properties & ob.properties) !== this.options.properties) {
          ready = false
        }

        // if sort is set in options maybe defer calling featureCallback
        if (ready) {
          this.featureCallback(null, ob, i)
          this.ids[i] = null
          continue
        }
      } else {
        // Illegal ID
        if (id !== null && !id.match(/^[nwr][0-9]+$/)) {
          this.featureCallback(null, null, i)
          this.ids[i] = null
          continue
        }
      }

      this.allFound = false
    }

    if (this.allFound) {
      this.finish()
    }
  }

  /**
   * compile the query
   * @param {OverpassFrontend#Context} context - Current context
   * @return {Request#SubRequest} - the compiled query
   */
  compileQuery (context) {
    super.compileQuery(context)

    var query = ''
    var nodeQuery = ''
    var wayQuery = ''
    var relationQuery = ''
    var BBoxQuery = ''
    var effort = 0

    if (this.options.bbox) {
      BBoxQuery = '(' + this.options.bbox.toLatLonString() + ')'
    }

    for (var i = 0; i < this.ids.length; i++) {
      var id = this.ids[i]
      var outOptions = overpassOutOptions(this.options)

      if (effort > context.maxEffort) {
        break
      }

      if (id === null) {
        continue
      }

      // don't load objects multiple times in same context
      if (id in context.todo) {
        continue
      }

      if (this.options.bbox) {
        // check if we already know the bbox of the element; if yes, don't try
        // to load object if it does not intersect bounds
        if (id in this.overpass.cacheElements && (this.overpass.cacheElements[id].properties & defines.BBOX)) {
          if (!this.overpass.cacheElements[id].intersects(this.options.bbox)) {
            continue
          }
        }
      }

      switch (id.substr(0, 1)) {
        case 'n':
          nodeQuery += 'node(' + id.substr(1) + ');\n'
          effort += this.overpass.options.effortNode
          break
        case 'w':
          wayQuery += 'way(' + id.substr(1) + ');\n'
          effort += this.overpass.options.effortWay
          break
        case 'r':
          relationQuery += 'relation(' + id.substr(1) + ');\n'
          effort += this.overpass.options.effortRelation
          break
      }

      context.todo[id] = true
    }

    if (nodeQuery !== '') {
      query += '((' + nodeQuery + ');)->.n;\n'
      if (BBoxQuery) {
        query += '(node.n; - node.n' + BBoxQuery + '->.n);\nout ids bb qt;\n'
      }
    }

    if (wayQuery !== '') {
      query += '((' + wayQuery + ');)->.w;\n'
      if (BBoxQuery) {
        query += '(way.w; - way.w' + BBoxQuery + '->.w);\nout ids bb qt;\n'
      }
    }

    if (relationQuery !== '') {
      query += '((' + relationQuery + ');)->.r;\n'
      if (BBoxQuery) {
        query += '(relation.r; - relation.r' + BBoxQuery + '->.r);\nout ids bb qt;\n'
      }
    }

    var requestParts = []
    if (BBoxQuery && (nodeQuery !== '' || wayQuery !== '' || relationQuery !== '')) {
      // additional separator to separate objects outside bbox from inside bbox
      query += 'out count;\n'

      requestParts.push({
        properties: defines.BBOX,
        bbox: this.options.bbox,
        bboxNoMatch: true,
        count: 0
      })
    }
    if (nodeQuery !== '') {
      query += '.n out ' + outOptions + ';\n'
    }
    if (wayQuery !== '') {
      query += '.w out ' + outOptions + ';\n'
    }
    if (relationQuery !== '') {
      query += '.r out ' + outOptions + ';\n'
    }

    requestParts.push({
      properties: this.options.properties,
      count: 0
    })

    var subRequest = {
      query,
      effort: effort,
      request: this,
      parts: requestParts
    }
    this.emit('subrequest-compile', subRequest)
    return subRequest
  }

  /**
   * receive an object from OverpassFronted -> enter to cache, return to caller
   * @param {OverpassObject} ob - Object which has been received
   * @param {Request#SubRequest} subRequest - sub request which is being handled right now
   * @param {int} partIndex - Which part of the subRequest is being received
   */
  receiveObject (ob, subRequest, partIndex) {
    var p
    var indexes = []

    subRequest.parts[partIndex].count++

    while ((p = this.ids.indexOf(ob.id)) !== -1) {
      this.ids[p] = null
      indexes.push(p)
    }

    if (this.aborted) {
      return
    }

    if (partIndex !== subRequest.parts.length - 1) {
      return
    }

    if (this.options.bbox && !ob.intersects(this.options.bbox)) {
      indexes.forEach(p => this.featureCallback(null, false, p))
      return
    }

    indexes.forEach(p => this.featureCallback(null, ob, p))
  }

  finishSubRequest (subRequest) {
    super.finishSubRequest(subRequest)

    if (!this.needLoad()) {
      this.finish()
    }
  }

  needLoad () {
    this.preprocess()

    return this.allFound
  }
}

module.exports = RequestGet
