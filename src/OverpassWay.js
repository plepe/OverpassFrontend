/* global L:false */

const async = require('async')
var BoundingBox = require('boundingbox')
var OverpassObject = require('./OverpassObject')
var OverpassFrontend = require('./defines')
var turf = {
  intersect: require('@turf/intersect').default,
  lineIntersect: require('@turf/line-intersect').default
}

const isGeoJSON = require('./isGeoJSON')

/**
 * A way
 * @property {string} id ID of this object, starting with 'w'.
 * @property {number} osm_id Numeric id.
 * @property {string} type Type: 'way'.
 * @property {object} tags OpenStreetMap tags.
 * @property {object} meta OpenStreetMap meta information.
 * @property {Point[]} geometry of the object
 * @property {object} data Data as loaded from Overpass API.
 * @property {bit_array} properties Which information about this object is known?
 * @property {object[]} memberOf List of relations where this object is member of.
 * @property {string} memberOf.id ID of the relation where this way is member of.
 * @property {string} memberOf.role Role of this object in the relation.
 * @property {number} memberOf.sequence This object is the nth member in the relation.
 * @property {BoundingBox} bounds Bounding box of this object.
 * @property {Point} center Centroid of the bounding box.
 * @property {object[]} members Nodes of the way.
 * @property {string} members.id ID of the member.
 * @property {number} members.ref Numeric ID of the member.
 * @property {string} members.type 'node'.
 */
class OverpassWay extends OverpassObject {
  updateData (data, options) {
    if (data.nodes) {
      this.nodes = data.nodes
    }

    if (data.geometry) {
      this.geometry = data.geometry
    }

    super.updateData(data, options)

    if (typeof this.data.nodes !== 'undefined') {
      this.members = []

      for (var i = 0; i < this.data.nodes.length; i++) {
        this.members.push({
          id: 'n' + this.data.nodes[i],
          ref: this.data.nodes[i],
          type: 'node'
        })

        let obProperties = OverpassFrontend.ID_ONLY
        let ob = {
          id: this.data.nodes[i],
          type: 'node'
        }

        if (data.geometry) {
          obProperties = obProperties | OverpassFrontend.GEOM
          ob.lat = data.geometry[i].lat
          ob.lon = data.geometry[i].lon
        }

        let memberOb = this.overpass.createOrUpdateOSMObject(ob, {
          properties: obProperties
        })

        memberOb.notifyMemberOf(this, null, i)
      }

      if (!this.geometry) {
        this.geometry = this.members.map(
          member => {
            let node = this.overpass.cacheElements[member.id]
            if (node) {
              return node.geometry
            }
          }
        )
        this.geometry = this.geometry.filter(geom => geom)

        if (!this.geometry.length) {
          delete this.geometry
        }
      }
    }

    if (this.geometry && this.geometry.filter(geom => geom).length === this.geometry.length) {
      this.properties = this.properties | OverpassFrontend.GEOM

      if (!this.bounds) {
        this.bounds = new BoundingBox(this.geometry[0])
        this.geometry.slice(1).forEach(geom => this.bounds.extend(geom))
        this.center = this.bounds.getCenter()
        this.properties = this.properties | OverpassFrontend.BBOX | OverpassFrontend.CENTER
      }
    }
  }

  notifyMemberUpdate (memberObs) {
    super.notifyMemberUpdate(memberObs)

    if (!this.members) {
      return
    }

    memberObs.forEach(memberOb => {
      this.members.forEach((member, index) => {
        if (memberOb.id === member.id) {
          if (memberOb.geometry) {
            if (!this.geometry) {
              this.geometry = new Array(this.members.length)
            }

            this.geometry[index] = memberOb.geometry
          }
        }

        if (this.bounds) {
          this.bounds.extend(memberOb.geometry)
        } else {
          this.bounds = new BoundingBox(memberOb.geometry)
        }
      })
    })

    // all nodes known -> set bbox, geom and center
    if (this.geometry && this.geometry.filter(geom => geom).length === this.geometry.length) {
      this.center = this.bounds.getCenter()
      this.properties = this.properties | OverpassFrontend.BBOX | OverpassFrontend.GEOM | OverpassFrontend.CENTER
    }
  }

  memberIds () {
    if (this._memberIds) {
      return this._memberIds
    }

    if (!this.nodes) {
      return null
    }

    this._memberIds = []
    for (var i = 0; i < this.nodes.length; i++) {
      var member = this.nodes[i]

      this._memberIds.push('n' + member)
    }

    return this._memberIds
  }

  member_ids () { // eslint-disable-line
    console.log('called deprecated OverpassWay.member_ids() function - replace by memberIds()')
    return this.memberIds()
  }

  GeoJSON () {
    var result = {
      type: 'Feature',
      id: this.type + '/' + this.osm_id,
      properties: this.GeoJSONProperties()
    }

    if (this.geometry) {
      let coordinates = this.geometry
        .filter(point => point) // discard non-loaded points
        .map(point => [ point.lon, point.lat ])
      let isClosed = this.members && this.members[0].id === this.members[this.members.length - 1].id

      if (isClosed) {
        result.geometry = {
          type: 'Polygon',
          coordinates: [ coordinates ]
        }
      } else {
        result.geometry = {
          type: 'LineString',
          coordinates: coordinates
        }
      }
    }

    return result
  }

  exportOSMXML (options, parentNode, callback) {
    super.exportOSMXML(options, parentNode,
      (err, result) => {
        if (err) {
          return callback(err)
        }

        if (!result) { // already included
          return callback(null)
        }

        if (this.members) {
          async.each(this.members,
            (member, done) => {
              let memberOb = this.overpass.cacheElements[member.id]

              let nd = parentNode.ownerDocument.createElement('nd')
              nd.setAttribute('ref', memberOb.osm_id)
              result.appendChild(nd)

              memberOb.exportOSMXML(options, parentNode, done)
            },
            (err) => {
              callback(err, result)
            }
          )
        } else {
          callback(null, result)
        }
      }
    )
  }

  exportOSMJSON (conf, elements, callback) {
    super.exportOSMJSON(conf, elements,
      (err, result) => {
        if (err) {
          return callback(err)
        }

        if (!result) { // already included
          return callback(null)
        }

        if (this.members) {
          result.nodes = []

          async.each(this.members,
            (member, done) => {
              let memberOb = this.overpass.cacheElements[member.id]

              result.nodes.push(memberOb.osm_id)

              memberOb.exportOSMJSON(conf, elements, done)
            },
            (err) => {
              callback(err, result)
            }
          )
        } else {
          callback(null, result)
        }
      }
    )
  }

  /**
   * return a leaflet feature for this object. If the ways is closed, a L.polygon will be returned, otherwise a L.polyline.
   * @param {object} [options] options Options will be passed to the leaflet function
   * @param {number[]} [options.shiftWorld=[0, 0]] Shift western (negative) longitudes by shiftWorld[0], eastern (positive) longitudes by shiftWorld[1] (e.g. by 360, 0 to show objects around lon=180)
   * @return {L.layer}
   */
  leafletFeature (options = {}) {
    if (!this.geometry) {
      return null
    }

    if (!('shiftWorld' in options)) {
      options.shiftWorld = [ 0, 0 ]
    }

    let geom = this.geometry.map(g => {
      return { lat: g.lat, lon: g.lon + options.shiftWorld[g.lon < 0 ? 0 : 1] }
    })

    if (this.geometry[this.geometry.length - 1].lat === this.geometry[0].lat &&
       this.geometry[this.geometry.length - 1].lon === this.geometry[0].lon) {
      return L.polygon(geom, options)
    }

    return L.polyline(geom, options)
  }

  intersects (bbox) {
    if (this.bounds) {
      if (!this.bounds.intersects(bbox)) {
        return 0
      }
      if (this.bounds.within(bbox)) {
        return 2
      }
    }

    if (this.geometry) {
      let thisGeojson = this.GeoJSON()
      let bboxGeojson
      let intersection

      if (isGeoJSON(bbox)) {
        bboxGeojson = bbox
      } else {
        bboxGeojson = bbox.toGeoJSON()
      }

      if (thisGeojson.geometry.type === 'Polygon') {
        intersection = turf.intersect(thisGeojson, bboxGeojson)
        return (intersection && intersection.geometry.coordinates.length) ? 2 : 0
      } else {
        intersection = turf.lineIntersect(thisGeojson, bboxGeojson)
        return intersection.features.length ? 2 : 0
      }
    }

    return super.intersects(bbox)
  }
}

module.exports = OverpassWay
