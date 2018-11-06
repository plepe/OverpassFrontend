/* global L:false */

var BoundingBox = require('boundingbox')
var osmtogeojson = require('osmtogeojson')
var OverpassObject = require('./OverpassObject')
var OverpassFrontend = require('./defines')
var turf = require('./turf')
const KnownArea = require('./knownArea')

/**
 * A relation
 * @property {string} id ID of this object, starting with 'r'.
 * @property {number} osm_id Numeric id.
 * @property {string} type Type: 'relation'.
 * @property {object} tags OpenStreetMap tags.
 * @property {object} meta OpenStreetMap meta information.
 * @property {GeoJSON} geometry of the object
 * @property {object} data Data as loaded from Overpass API.
 * @property {bit_array} properties Which information about this object is known?
 * @property {object[]} memberOf List of relations where this object is member of.
 * @property {string} memberOf.id ID of the relation where this object is member of.
 * @property {string} memberOf.role Role of this object in the relation.
 * @property {number} memberOf.sequence This object is the nth member in the relation.
 * @property {BoundingBox} bounds Bounding box of this object.
 * @property {KnownArea} [knownMemberArea] Area where all members are already known.
 * @property {Point} center Centroid of the bounding box.
 * @property {object[]} members Nodes of the way.
 * @property {string} members.id ID of the member.
 * @property {number} members.ref Numeric ID of the member.
 * @property {string} members.type 'node'.
 * @property {string} members.role Role of the member.
 */
class OverpassRelation extends OverpassObject {
  updateData (data, options) {
    var i

    super.updateData(data, options)

    if ((options.properties & OverpassFrontend.MEMBERS) &&
        data.members) {
      this.members = []

      for (i = 0; i < data.members.length; i++) {
        var member = data.members[i]

        this.members.push(member)
        this.members[i].id = member.type.substr(0, 1) + member.ref
      }
    }

    if (options.properties & OverpassFrontend.MEMBERS) {
      this.memberFeatures = data.members.map(
        (member, sequence) => {
          let ob = JSON.parse(JSON.stringify(member))
          ob.id = ob.ref
          delete ob.ref
          delete ob.role

          let memberOb = this.overpass.createOrUpdateOSMObject(ob, {
            properties: options.properties & OverpassFrontend.GEOM
          })

          memberOb.notifyMemberOf(this, member.role, sequence)

          return memberOb
        }
      )
    }

    if ((options.properties & OverpassFrontend.MEMBERS) &&
        (options.properties & OverpassFrontend.GEOM) &&
        data.members) {
      let elements = [ JSON.parse(JSON.stringify(data)) ]
      this.geometry = osmtogeojson({ elements })
    } else if ((options.properties & OverpassFrontend.MEMBERS) &&
        data.members) {
      this.updateGeometry()
    }

    if (!this.knownMemberArea && this.bounds) {
      let area = new BoundingBox({ minlat: -90, maxlat: 90, minlon: -180, maxlon: 180 }).toGeoJSON()
      area = turf.difference(area, this.bounds.toGeoJSON())
      this.knownMemberArea = new KnownArea(area)
    }
  }

  updateGeometry () {
    if (!this.members) {
      return
    }

    let allKnown = true
    let elements = [ {
      type: 'relation',
      id: this.osm_id,
      tags: this.tags,
      members: this.members.map(member => {
        let data = {
          ref: member.ref,
          type: member.type,
          role: member.role
        }

        if (!(member.id in this.overpass.cacheElements)) {
          allKnown = false
          return data
        }

        let ob = this.overpass.cacheElements[member.id]

        if (ob.type === 'node') {
          if (ob.geometry) {
            data.lat = ob.geometry.lat
            data.lon = ob.geometry.lon
          }
        } else if (ob.type === 'way') {
          data.geometry = ob.geometry
        }

        return data
      })
    } ]

    this.geometry = osmtogeojson({ elements })
    if (allKnown) {
      this.properties = this.properties | OverpassFrontend.GEOM
    }

    if (!this.bounds) {
      this.members.forEach(member => {
        let ob = this.overpass.cacheElements[member.id]
        if (ob.bounds) {
          if (this.bounds) {
            this.bounds.extend(ob.bounds)
          } else {
            this.bounds = new BoundingBox(ob.bounds)
          }
        }
      })

      if (this.bounds && allKnown) {
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

    this.updateGeometry()
  }

  /**
   * Return list of member ids.
   * @return {string[]}
   */
  memberIds () {
    if (this._memberIds) {
      return this._memberIds
    }

    if (typeof this.data.members === 'undefined') {
      return null
    }

    this._memberIds = []
    for (var i = 0; i < this.data.members.length; i++) {
      var member = this.data.members[i]

      this._memberIds.push(member.type.substr(0, 1) + member.ref)
    }

    return this._memberIds
  }

  member_ids () { // eslint-disable-line
    console.log('called deprecated OverpassRelation.member_ids() function - replace by memberIds()')
    return this.memberIds()
  }

  /**
   * return a leaflet feature for this object.
   * @param {object} [options] options Options will be passed to the leaflet function
   * @return {L.layer}
   */
  leafletFeature (options) {
    if (!this.data.members) {
      return null
    }

    // no geometry? use the member features instead
    if (!this.geometry) {
      let feature = L.featureGroup()
      feature._updateCallbacks = []

      return feature
    }

    var feature = L.geoJSON(this.geometry, {
      pointToLayer: function (options, geoJsonPoint, member) {
        let feature

        switch (options.nodeFeature) {
          case 'Marker':
            feature = L.marker(member, options)
            break
          case 'Circle':
            feature = L.circle(member, options.radius, options)
            break
          case 'CircleMarker':
          default:
            feature = L.circleMarker(member, options)
        }

        return feature
      }.bind(this, options)
    })
    feature.setStyle(options)

    // create an event handler on the 'update' event, so that loading member
    // features will update geometry
    this.memberFeatures.forEach(
      (member, index) => {
        if (!(member.properties & OverpassFrontend.GEOM)) {
          let updFun = member => {
            feature.clearLayers()
            feature.addData(this.geometry)
            feature.setStyle(options)
          }

          member.once('update', updFun)
        }
      }
    )

    return feature
  }

  GeoJSON () {
    var ret = {
      type: 'Feature',
      id: this.type + '/' + this.osm_id,
      properties: this.GeoJSONProperties()
    }

    if (this.members) {
      ret.geometry = {
        type: 'GeometryCollection',
        geometries: this.memberFeatures
          .map(member => {
            let geojson = member.GeoJSON()
            if ('geometry' in geojson) {
              return geojson.geometry
            }
          })
          .filter(member => member)
      }
    }

    return ret
  }

  intersects (bbox) {
    var i

    if (this.bounds) {
      if (!bbox.intersects(this.bounds)) {
        return 0
      }
    }

    if (this.geometry) {
      for (i = 0; i < this.geometry.features.length; i++) {
        var g = this.geometry.features[i]

        if (g.geometry.type === 'Point') {
          if (bbox.intersects(g)) {
            return 2
          }
          continue
        }

        var intersects = turf.bboxClip(g, [ bbox.minlon, bbox.minlat, bbox.maxlon, bbox.maxlat ])

        if (g.geometry.type === 'LineString' || g.geometry.type === 'Polygon') {
          if (intersects.geometry.coordinates.length) {
            return 2
          }
        }
        if (g.geometry.type === 'MultiPolygon' || g.geometry.type === 'MultiLineString') {
          for (var j = 0; j < intersects.geometry.coordinates.length; j++) {
            if (intersects.geometry.coordinates[j].length) {
              return 2
            }
          }
        }
      }

      // if there's a relation member (where Overpass does not return the
      // geometry) we can't know if the geometry intersects -> return 1
      for (i = 0; i < this.data.members.length; i++) {
        if (this.data.members[i].type === 'relation') {
          return 1
        }
      }

      // there's a relation member whose geometry is not known
      if (!this.knownMemberArea.check(bbox) && this.memberFeatures.some(member => !(member.properties & OverpassFrontend.GEOM))) {
        return 1
      }

      // if there's no relation member we can be sure there's no intersection
      return 0
    } else if (this.members) {
      for (i in this.members) {
        let memberId = this.members[i].id
        let member = this.overpass.cacheElements[memberId]

        if (member) {
          if (member.intersects(bbox) === 2) {
            return 2
          }
        }
      }
    }

    return super.intersects(bbox)
  }
}

module.exports = OverpassRelation
