const Request = require('./Request')
const overpassOutOptions = require('./overpassOutOptions')
const defines = require('./defines')
const KnownArea = require('./knownArea')
const RequestBBoxMembers = require('./RequestBBoxMembers')
const Filter = require('./Filter')

/**
 * A BBox request
 * @extends Request
 */
class RequestBBox extends Request {
  /**
   * @param {OverpassFrontend} overpass
   * @param {object} options
   */
  constructor (overpass, data) {
    super(overpass, data)
    this.type = 'BBoxQuery'

    if (typeof this.options.properties === 'undefined') {
      this.options.properties = defines.DEFAULT
    }
    this.options.properties |= defines.BBOX
    this.options.minEffort = this.options.minEffort || 256

    // make sure the request ends with ';'
    if (!this.query.match(/;\s*$/)) {
      this.query += ';'
    }

    if ((typeof this.options.filter !== 'undefined') && !(this.options.filter instanceof Filter)) {
      this.options.filter = new Filter(this.options.filter)
    }

    let filterId = null
    if (this.options.filter) {
      filterId = this.options.filter.toString()
    }

    if (!('noCacheQuery' in this.options) || !this.options.noCacheQuery) {
      this.filterQuery = new Filter(this.query)

      this.lokiQuery = this.filterQuery.toLokijs()
      this.lokiQueryNeedMatch = !!this.lokiQuery.needMatch
      delete this.lokiQuery.needMatch

      if (this.options.filter) {
        let filterLokiQuery = this.options.filter.toLokijs()
        this.lokiQueryFilterNeedMatch = !!filterLokiQuery.needMatch
        delete filterLokiQuery.needMatch

        this.lokiQuery = { $and: [ this.lokiQuery, filterLokiQuery ] }
      }

      if (this.bounds) {
        this.lokiQuery.minlat = { $lte: this.bounds.maxlat }
        this.lokiQuery.minlon = { $lte: this.bounds.maxlon }
        this.lokiQuery.maxlat = { $gte: this.bounds.minlat }
        this.lokiQuery.maxlon = { $gte: this.bounds.minlon }
      }
    }

    this.loadFinish = false
    this.lastChecked = 0

    if ('members' in this.options) {
      RequestBBoxMembers(this)
    }

    if (this.query in this.overpass.cacheBBoxQueries) {
      this.cache = this.overpass.cacheBBoxQueries[this.query]

      if (filterId) {
        if (!('filter' in this.cache)) {
          this.cache.filter = {}
        }

        if (!(filterId in this.cache.filter)) {
          this.cache.filter[filterId] = new KnownArea()
        }

        this.cacheFilter = this.cache.filter[filterId]
      }
    } else {
      // otherwise initialize cache
      this.overpass.cacheBBoxQueries[this.query] = {}
      this.cache = this.overpass.cacheBBoxQueries[this.query]
      this.cache.requested = new KnownArea()
      this.cache.timestamp = 0

      if (filterId) {
        this.cache.filter = {}
        this.cache.filter[filterId] = new KnownArea()
        this.cacheFilter = this.cache.filter[filterId]
      }
    }
  }

  /**
   * check if there are any map features which can be returned right now
   */
  preprocess () {
    if (this.lastChecked > this.cache.timestamp) {
      if (!this.needLoad()) {
        return
      }
    }
    this.lastChecked = new Date().getTime()

    var items = []
    if (this.lokiQuery) {
      items = this.overpass.db.find(this.lokiQuery)
    }

    for (var i = 0; i < items.length; i++) {
      var id = items[i].id

      if (!(id in this.overpass.cacheElements)) {
        continue
      }
      var ob = this.overpass.cacheElements[id]

      if (id in this.doneFeatures) {
        continue
      }

      // maybe we need an additional check
      if (this.lokiQueryNeedMatch && !this.filterQuery.match(ob)) {
        continue
      }

      if (this.lokiQueryFilterNeedMatch && !this.option.filter.match(ob)) {
        continue
      }

      // also check the object directly if it intersects the bbox - if possible
      if (ob.intersects(this.bounds) < 2) {
        continue
      }

      if ((this.options.properties & ob.properties) === this.options.properties) {
        this.doneFeatures[id] = ob

        this.featureCallback(null, ob)
      }
    }
  }

  /**
   * shall this Request be included in the current call?
   * @param {OverpassFrontend#Context} context - Current context
   * @return {boolean|int[]} - yes|no - or [ minEffort, maxEffort ]
   */
  willInclude (context) {
    if (this.loadFinish) {
      return false
    }

    if (context.bbox && context.bbox.toLatLonString() !== this.bounds.toLatLonString()) {
      return false
    }
    context.bbox = this.bounds

    for (let i in context.requests) {
      let request = context.requests[i]
      if (request instanceof RequestBBox && request.query === this.query) {
        return false
      }
    }

    return true
  }

  /**
   * how much effort can a call to this request use
   * @return {Request#minMaxEffortResult} - minimum and maximum effort
   */
  minMaxEffort () {
    if (this.loadFinish) {
      return { minEffort: 0, maxEffort: 0 }
    }

    return { minEffort: this.options.minEffort, maxEffort: null }
  }

  /**
   * compile the query
   * @param {OverpassFrontend#Context} context - Current context
   * @return {Request#SubRequest|false} - the compiled query or false if the bbox does not match
   */
  _compileQuery (context) {
    if (this.loadFinish || (context.bbox && context.bbox.toLatLonString() !== this.bounds.toLatLonString())) {
      return {
        query: '',
        request: this,
        parts: [],
        effort: 0
      }
    }

    let effortAvailable = Math.max(context.maxEffort, this.options.minEffort)

    // if the context already has a bbox and it differs from this, we can't add
    // ours
    var query = '(' + this.query + ')->.result;\n'

    var queryRemoveDoneFeatures = ''
    var countRemoveDoneFeatures = 0
    for (var id in this.doneFeatures) {
      var ob = this.doneFeatures[id]

      if (countRemoveDoneFeatures % 1000 === 999) {
        query += '(' + queryRemoveDoneFeatures + ')->.done;\n'
        queryRemoveDoneFeatures = '.done;'
      }

      queryRemoveDoneFeatures += ob.type + '(' + ob.osm_id + ');'
      countRemoveDoneFeatures++
    }

    if (countRemoveDoneFeatures) {
      query += '(' + queryRemoveDoneFeatures + ')->.done;\n'
      query += '(.result; - .done;)->.result;\n'
    }

    if (this.options.filter) {
      query += this.options.filter.toQl({
        inputSet: '.result'
      }) + '->.result;\n'
    }

    if (!('split' in this.options)) {
      this.options.effortSplit = Math.ceil(effortAvailable / 4)
    }
    query += '.result out ' + overpassOutOptions(this.options) + ';'

    var subRequest = {
      query,
      request: this,
      parts: [
        {
          properties: this.options.properties,
          receiveObject: this.receiveObject.bind(this),
          featureCallback: this.featureCallback
        }
      ],
      effort: this.options.split ? this.options.split * 4 : effortAvailable // TODO: configure bbox effort
    }
    return subRequest
  }

  /**
   * receive an object from OverpassFronted -> enter to cache, return to caller
   * @param {OverpassObject} ob - Object which has been received
   * @param {Request#SubRequest} subRequest - sub request which is being handled right now
   * @param {int} partIndex - Which part of the subRequest is being received
   */
  receiveObject (ob) {
    this.doneFeatures[ob.id] = ob
  }

  /**
   * the current subrequest is finished -> update caches, check whether request is finished
   * @param {Request#SubRequest} subRequest - the current sub request
   */
  finishSubRequest (subRequest) {
    super.finishSubRequest(subRequest)

    this.cache.timestamp = new Date().getTime()

    if (('effortSplit' in this.options && this.options.effortSplit > subRequest.parts[0].count) ||
        (this.options.split > subRequest.parts[0].count)) {
      this.loadFinish = true

      if (this.options.filter) {
        this.cacheFilter.add(this.remainingBounds)
      } else {
        this.cache.requested.add(this.remainingBounds)
      }
    }
  }

  /**
   * check if we need to call Overpass API. Maybe whole area is cached anyway?
   * @return {boolean} - true, if we need to call Overpass API
   */
  needLoad () {
    if (this.loadFinish) {
      return false
    }

    // check if we need to call Overpass API (whole area known?)
    if (this.options.filter && this.cacheFilter.check(this.bounds)) {
      return false
    }

    return !this.cache.requested.check(this.bounds)
  }

  mayFinish () {
    return !this.needLoad()
  }
}

module.exports = RequestBBox
