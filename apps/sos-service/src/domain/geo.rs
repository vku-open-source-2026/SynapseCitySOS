// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Hazard geospatial queries.
//!
//! Radius search uses the haversine distance on the WGS84 sphere and polygon
//! search uses a ray-casting point-in-polygon test. Invalid input is rejected
//! instead of returning the whole dataset (issue #12).

use crate::domain::error::{bad_request, DomainError};
use crate::domain::filters::{js_number, js_string, non_null, Data};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

/// A GeoJSON linear ring: `[lng, lat]` positions, first equals last.
pub type Ring = Vec<[f64; 2]>;
/// GeoJSON polygon rings: the shell followed by zero or more holes.
pub type PolygonRings = Vec<Ring>;

pub const EARTH_RADIUS_M: f64 = 6_371_008.8;
pub const MAX_RADIUS_M: f64 = 50_000.0;
pub const MIN_RADIUS_M: f64 = 1.0;
pub const MAX_POLYGON_VERTICES: usize = 10_000;
pub const MAX_RINGS: usize = 64;
pub const DEFAULT_RADIUS_M: f64 = 5_000.0;

pub fn to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

/// Great-circle distance in metres. Handles antimeridian crossings.
pub fn haversine_meters(a: LatLng, b: LatLng) -> f64 {
    let d_lat = to_radians(b.lat - a.lat);
    let mut d_lng = b.lng - a.lng;
    // Normalise to the shortest longitude delta so a ±180° crossing works.
    if d_lng > 180.0 {
        d_lng -= 360.0;
    }
    if d_lng < -180.0 {
        d_lng += 360.0;
    }
    let rad_lng = to_radians(d_lng);
    let lat1 = to_radians(a.lat);
    let lat2 = to_radians(b.lat);
    let x = (d_lat / 2.0).sin().powi(2)
        + (rad_lng / 2.0).sin().powi(2) * lat1.cos() * lat2.cos();
    2.0 * EARTH_RADIUS_M * x.sqrt().min(1.0).asin()
}

/// Parse and range-check `lat`/`lng` query values.
pub fn parse_coordinates(
    lat_value: Option<&Value>,
    lng_value: Option<&Value>,
) -> Result<LatLng, DomainError> {
    let lat = js_number(lat_value);
    let lng = js_number(lng_value);
    let (Some(lat), Some(lng)) = (lat, lng) else {
        return Err(bad_request(
            "coordinates_required",
            "lat and lng must be finite numbers",
            None,
        ));
    };
    if !(-90.0..=90.0).contains(&lat) {
        return Err(bad_request(
            "invalid_coordinates",
            "lat must be between -90 and 90",
            None,
        ));
    }
    if !(-180.0..=180.0).contains(&lng) {
        return Err(bad_request(
            "invalid_coordinates",
            "lng must be between -180 and 180",
            None,
        ));
    }
    Ok(LatLng { lat, lng })
}

/// Parse `radius_m`, defaulting to 5 km and bounding it to 1 m .. 50 km.
pub fn parse_radius(value: Option<&Value>, fallback: Option<f64>) -> Result<f64, DomainError> {
    let fallback = fallback.unwrap_or(DEFAULT_RADIUS_M);
    if value.is_none() || matches!(value, Some(Value::Null)) {
        return Ok(fallback);
    }
    if let Some(Value::String(text)) = value {
        if text.is_empty() {
            return Ok(fallback);
        }
    }
    let Some(parsed) = js_number(value) else {
        return Err(bad_request(
            "invalid_radius",
            "radius_m must be a finite number",
            None,
        ));
    };
    if parsed < MIN_RADIUS_M || parsed > MAX_RADIUS_M {
        return Err(bad_request(
            "invalid_radius",
            format!(
                "radius_m must be between {} and {}",
                MIN_RADIUS_M as i64, MAX_RADIUS_M as i64
            ),
            None,
        ));
    }
    Ok(parsed)
}

fn is_position(value: &Value) -> bool {
    let Value::Array(items) = value else {
        return false;
    };
    if items.len() < 2 {
        return false;
    }
    let lng = js_number(Some(&items[0]));
    let lat = js_number(Some(&items[1]));
    matches!((lng, lat), (Some(lng), Some(lat)) if lng.abs() <= 180.0 && lat.abs() <= 90.0)
}

fn validate_ring(ring: &Value) -> Result<Ring, DomainError> {
    let Value::Array(positions) = ring else {
        return Err(bad_request(
            "invalid_geometry",
            "each polygon ring needs at least 4 positions",
            None,
        ));
    };
    if positions.len() < 4 {
        return Err(bad_request(
            "invalid_geometry",
            "each polygon ring needs at least 4 positions",
            None,
        ));
    }
    if positions.len() > MAX_POLYGON_VERTICES {
        return Err(bad_request(
            "invalid_geometry",
            format!("polygon ring exceeds {} positions", MAX_POLYGON_VERTICES),
            None,
        ));
    }
    let mut output: Ring = Vec::with_capacity(positions.len());
    for position in positions {
        if !is_position(position) {
            return Err(bad_request(
                "invalid_geometry",
                "polygon position must be [lng, lat]",
                None,
            ));
        }
        let items = position.as_array().expect("validated position");
        let lng = js_number(Some(&items[0])).expect("validated lng");
        let lat = js_number(Some(&items[1])).expect("validated lat");
        output.push([lng, lat]);
    }
    let first = output[0];
    let last = output[output.len() - 1];
    if first[0] != last[0] || first[1] != last[1] {
        return Err(bad_request(
            "invalid_geometry",
            "polygon ring must be closed (first equals last)",
            None,
        ));
    }
    Ok(output)
}

/// A validated GeoJSON Polygon or MultiPolygon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GeoArea {
    Polygon { coordinates: PolygonRings },
    MultiPolygon { coordinates: Vec<PolygonRings> },
}

/// Validate a GeoJSON Polygon or MultiPolygon.
pub fn validate_polygon(input: &Value) -> Result<GeoArea, DomainError> {
    let Value::Object(geometry) = input else {
        return Err(bad_request(
            "invalid_geometry",
            "polygon must be a GeoJSON Polygon or MultiPolygon",
            None,
        ));
    };
    let geometry_type = geometry
        .get("type")
        .map(js_string)
        .unwrap_or_default();
    let coordinates = geometry.get("coordinates");
    match geometry_type.as_str() {
        "Polygon" => {
            let Some(Value::Array(rings)) = coordinates else {
                return Err(bad_request(
                    "invalid_geometry",
                    "polygon coordinates must contain 1..64 rings",
                    None,
                ));
            };
            if rings.is_empty() || rings.len() > MAX_RINGS {
                return Err(bad_request(
                    "invalid_geometry",
                    "polygon coordinates must contain 1..64 rings",
                    None,
                ));
            }
            let mut validated = Vec::with_capacity(rings.len());
            for ring in rings {
                validated.push(validate_ring(ring)?);
            }
            Ok(GeoArea::Polygon {
                coordinates: validated,
            })
        }
        "MultiPolygon" => {
            let Some(Value::Array(polygons)) = coordinates else {
                return Err(bad_request(
                    "invalid_geometry",
                    "multipolygon coordinates must contain 1..64 polygons",
                    None,
                ));
            };
            if polygons.is_empty() || polygons.len() > MAX_RINGS {
                return Err(bad_request(
                    "invalid_geometry",
                    "multipolygon coordinates must contain 1..64 polygons",
                    None,
                ));
            }
            let mut validated = Vec::with_capacity(polygons.len());
            for polygon in polygons {
                let Value::Array(rings) = polygon else {
                    return Err(bad_request(
                        "invalid_geometry",
                        "each multipolygon member needs rings",
                        None,
                    ));
                };
                if rings.is_empty() {
                    return Err(bad_request(
                        "invalid_geometry",
                        "each multipolygon member needs rings",
                        None,
                    ));
                }
                let mut validated_rings = Vec::with_capacity(rings.len());
                for ring in rings {
                    validated_rings.push(validate_ring(ring)?);
                }
                validated.push(validated_rings);
            }
            Ok(GeoArea::MultiPolygon {
                coordinates: validated,
            })
        }
        _ => Err(bad_request(
            "invalid_geometry",
            "geometry.type must be Polygon or MultiPolygon",
            None,
        )),
    }
}

fn ring_contains_point(ring: &[[f64; 2]], point: LatLng) -> bool {
    if ring.is_empty() {
        return false;
    }
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let [xi, yi] = ring[i];
        let [xj, yj] = ring[j];
        let denominator = if yj - yi == 0.0 {
            f64::EPSILON
        } else {
            yj - yi
        };
        let intersects = ((yi > point.lat) != (yj > point.lat))
            && point.lng < ((xj - xi) * (point.lat - yi)) / denominator + xi;
        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Ray-casting point-in-polygon test for one ring.
pub fn point_in_polygon(point: LatLng, ring: &[[f64; 2]]) -> bool {
    ring_contains_point(ring, point)
}

fn polygon_contains_point(rings: &[Ring], point: LatLng) -> bool {
    if rings.is_empty() {
        return false;
    }
    if !ring_contains_point(&rings[0], point) {
        return false;
    }
    // Inside a hole means outside the polygon.
    !rings[1..]
        .iter()
        .any(|hole| ring_contains_point(hole, point))
}

/// Point-in-polygon with hole support (ring 0 is the shell).
pub fn area_contains_point(area: &GeoArea, point: LatLng) -> bool {
    match area {
        GeoArea::Polygon { coordinates } => polygon_contains_point(coordinates, point),
        GeoArea::MultiPolygon { coordinates } => coordinates
            .iter()
            .any(|rings| polygon_contains_point(rings, point)),
    }
}

fn as_number_pair(value: &Value) -> Option<LatLng> {
    let Value::Array(items) = value else {
        return None;
    };
    if items.len() < 2 {
        return None;
    }
    let lng = js_number(Some(&items[0]))?;
    let lat = js_number(Some(&items[1]))?;
    Some(LatLng { lat, lng })
}

fn push_pairs(value: Option<&Value>, points: &mut Vec<LatLng>) {
    let Some(Value::Array(items)) = value else {
        return;
    };
    for item in items {
        if let Some(point) = as_number_pair(item) {
            points.push(point);
        }
    }
}

fn metadata_of(row: &Data) -> Option<&Data> {
    row.get("metadata").and_then(Value::as_object)
}

/// Extract representative points from a hazard record.
///
/// Supports a top-level `geometry` (Point/MultiPoint/Polygon/MultiPolygon/
/// LineString) plus the legacy `lat`/`lon` and `metadata.lat`/`metadata.lon`
/// fields used by VNDMS imports.
pub fn hazard_points(row: &Data) -> Vec<LatLng> {
    let mut points: Vec<LatLng> = Vec::new();
    if let Some(geometry) = row.get("geometry").and_then(Value::as_object) {
        let geometry_type = geometry
            .get("type")
            .map(js_string)
            .unwrap_or_default();
        let coordinates = geometry.get("coordinates");
        match geometry_type.as_str() {
            "Point" => {
                if let Some(point) = coordinates.and_then(as_number_pair) {
                    points.push(point);
                }
            }
            "MultiPoint" | "LineString" | "MultiLineString" => {
                push_pairs(coordinates, &mut points);
            }
            "Polygon" => {
                let shell = coordinates
                    .and_then(Value::as_array)
                    .and_then(|rings| rings.first());
                push_pairs(shell, &mut points);
            }
            "MultiPolygon" => {
                if let Some(Value::Array(polygons)) = coordinates {
                    for polygon in polygons {
                        let shell = polygon.as_array().and_then(|rings| rings.first());
                        push_pairs(shell, &mut points);
                    }
                }
            }
            _ => {}
        }
    }

    if points.is_empty() {
        let metadata = metadata_of(row);
        let lat_value = non_null(row, "lat")
            .or_else(|| metadata.and_then(|metadata| non_null(metadata, "lat")));
        let lng_value = non_null(row, "lon")
            .or_else(|| non_null(row, "lng"))
            .or_else(|| metadata.and_then(|metadata| non_null(metadata, "lon")))
            .or_else(|| metadata.and_then(|metadata| non_null(metadata, "lng")));
        if let (Some(lat), Some(lng)) = (js_number(lat_value), js_number(lng_value)) {
            points.push(LatLng { lat, lng });
        }
    }
    points
}

/// Minimum distance from `origin` to any representative hazard point.
pub fn hazard_distance_meters(row: &Data, origin: LatLng) -> Option<f64> {
    let points = hazard_points(row);
    if points.is_empty() {
        return None;
    }
    Some(
        points
            .iter()
            .map(|point| haversine_meters(origin, *point))
            .fold(f64::INFINITY, f64::min),
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct NearQuery {
    pub lat: f64,
    pub lng: f64,
    pub radius_m: f64,
    pub limit: usize,
    pub offset: usize,
}

/// Parse the `/hazards/geo/near` query contract.
pub fn parse_near_query(query: &Data) -> Result<NearQuery, DomainError> {
    let origin = parse_coordinates(query.get("lat"), query.get("lng"))?;
    let radius_m = parse_radius(query.get("radius_m"), None)?;
    let raw_limit = match js_number(query.get("limit")) {
        Some(value) if value != 0.0 => value,
        _ => 200.0,
    };
    let limit = raw_limit.floor().max(1.0).min(500.0) as usize;
    let raw_offset = non_null(query, "skip")
        .or_else(|| non_null(query, "offset"))
        .and_then(|value| js_number(Some(value)))
        .unwrap_or(0.0);
    let offset = raw_offset.floor().max(0.0) as usize;
    Ok(NearQuery {
        lat: origin.lat,
        lng: origin.lng,
        radius_m,
        limit,
        offset,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct NearResult {
    pub items: Vec<Data>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
    pub radius_m: f64,
}

fn id_of(row: &Data) -> String {
    row.get("id")
        .map(js_string)
        .unwrap_or_else(|| "undefined".to_string())
}

/// Radius filter, sorted by ascending distance with a stable id tiebreaker.
pub fn near_hazards(rows: &[Data], query: &NearQuery) -> NearResult {
    let origin = LatLng {
        lat: query.lat,
        lng: query.lng,
    };
    let mut matches: Vec<(Data, f64)> = rows
        .iter()
        .filter_map(|row| {
            hazard_distance_meters(row, origin)
                .filter(|distance| *distance <= query.radius_m)
                .map(|distance| (row.clone(), distance))
        })
        .collect();
    matches.sort_by(|left, right| {
        left.1
            .partial_cmp(&right.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| id_of(&left.0).cmp(&id_of(&right.0)))
    });
    let items = matches
        .iter()
        .skip(query.offset)
        .take(query.limit)
        .map(|(row, distance)| {
            let mut item = row.clone();
            item.insert(
                "distance_m".to_string(),
                Value::from(distance.round() as i64),
            );
            item
        })
        .collect();
    NearResult {
        items,
        total: matches.len(),
        limit: query.limit,
        offset: query.offset,
        radius_m: query.radius_m,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PolygonResult {
    pub items: Vec<Data>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

/// In-polygon filter, sorted by id.
pub fn in_polygon_hazards(
    rows: &[Data],
    area: &GeoArea,
    limit: usize,
    offset: usize,
) -> PolygonResult {
    let mut matches: Vec<Data> = rows
        .iter()
        .filter(|row| {
            hazard_points(row)
                .into_iter()
                .any(|point| area_contains_point(area, point))
        })
        .cloned()
        .collect();
    matches.sort_by(|left, right| id_of(left).cmp(&id_of(right)));
    let total = matches.len();
    PolygonResult {
        items: matches.into_iter().skip(offset).take(limit).collect(),
        total,
        limit,
        offset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HANOI: LatLng = LatLng {
        lat: 21.0278,
        lng: 105.8342,
    };
    const HCMC: LatLng = LatLng {
        lat: 10.8231,
        lng: 106.6297,
    };

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn haversine_is_plausible_and_symmetric() {
        let distance = haversine_meters(HANOI, HCMC);
        assert!(
            distance > 1_100_000.0 && distance < 1_200_000.0,
            "unexpected distance {distance}"
        );
        assert!((distance - haversine_meters(HCMC, HANOI)).abs() < 0.001);
    }

    #[test]
    fn haversine_handles_the_antimeridian() {
        let distance = haversine_meters(
            LatLng { lat: 0.0, lng: 179.9 },
            LatLng { lat: 0.0, lng: -179.9 },
        );
        assert!(distance < 30_000.0, "antimeridian distance {distance}");
    }

    #[test]
    fn point_in_polygon_handles_inside_and_outside() {
        let ring = vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 10.0],
            [0.0, 10.0],
            [0.0, 0.0],
        ];
        assert!(point_in_polygon(LatLng { lat: 5.0, lng: 5.0 }, &ring));
        assert!(!point_in_polygon(LatLng { lat: 15.0, lng: 5.0 }, &ring));
        assert!(!point_in_polygon(
            LatLng {
                lat: 10.0001,
                lng: 5.0
            },
            &ring
        ));
    }

    #[test]
    fn polygon_holes_are_respected() {
        let area = validate_polygon(&json!({
            "type": "Polygon",
            "coordinates": [
                [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
                [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
            ]
        }))
        .expect("valid polygon");
        assert!(area_contains_point(
            &area,
            LatLng { lat: 2.0, lng: 2.0 }
        ));
        assert!(!area_contains_point(
            &area,
            LatLng { lat: 5.0, lng: 5.0 }
        ));
    }

    #[test]
    fn multipolygon_members_are_all_checked() {
        let area = validate_polygon(&json!({
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
                [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]]
            ]
        }))
        .expect("valid multipolygon");
        assert!(area_contains_point(
            &area,
            LatLng { lat: 1.0, lng: 1.0 }
        ));
        assert!(area_contains_point(
            &area,
            LatLng {
                lat: 11.0,
                lng: 11.0
            }
        ));
        assert!(!area_contains_point(
            &area,
            LatLng { lat: 6.0, lng: 6.0 }
        ));
    }

    #[test]
    fn polygon_validation_rejects_open_and_unbounded_input() {
        let err = validate_polygon(&json!({
            "type": "Polygon",
            "coordinates": [[[0, 0], [1, 0], [1, 1]]]
        }))
        .expect_err("too few positions");
        assert_eq!(err.code, "invalid_geometry");

        let err = validate_polygon(&json!({
            "type": "Polygon",
            "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1]]]
        }))
        .expect_err("open ring");
        assert!(err.message.contains("closed"));

        let err = validate_polygon(&json!({"type": "Point", "coordinates": [0, 0]}))
            .expect_err("wrong type");
        assert!(err.message.contains("Polygon"));

        assert!(validate_polygon(&json!([])).is_err());
    }

    #[test]
    fn coordinate_and_radius_parsing_reject_invalid_values() {
        let parsed = parse_coordinates(Some(&json!("16")), Some(&json!("108"))).expect("valid");
        assert_eq!(parsed, LatLng { lat: 16.0, lng: 108.0 });
        assert_eq!(
            parse_coordinates(Some(&json!("nope")), Some(&json!("108")))
                .expect_err("non numeric")
                .code,
            "coordinates_required"
        );
        assert_eq!(
            parse_coordinates(Some(&json!("91")), Some(&json!("108")))
                .expect_err("lat range")
                .code,
            "invalid_coordinates"
        );
        assert_eq!(parse_radius(None, None).expect("default"), 5_000.0);
        assert!(parse_radius(Some(&json!(0)), None).is_err());
        assert!(parse_radius(Some(&json!(50_001)), None).is_err());
    }

    #[test]
    fn hazard_points_supports_geojson_and_legacy_fields() {
        let point = row(json!({"geometry": {"type": "Point", "coordinates": [108, 16]}}));
        assert_eq!(
            hazard_points(&point),
            vec![LatLng { lat: 16.0, lng: 108.0 }]
        );

        let polygon = row(json!({
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
        }));
        assert_eq!(hazard_points(&polygon).len(), 4);

        let legacy = row(json!({"lat": 16, "lon": 108}));
        assert_eq!(
            hazard_points(&legacy),
            vec![LatLng { lat: 16.0, lng: 108.0 }]
        );

        let metadata = row(json!({"metadata": {"lat": "16", "lon": "108"}}));
        assert_eq!(
            hazard_points(&metadata),
            vec![LatLng { lat: 16.0, lng: 108.0 }]
        );

        assert!(hazard_points(&row(json!({"id": "none"}))).is_empty());
    }

    #[test]
    fn near_results_are_filtered_sorted_and_paginated() {
        let rows = vec![
            row(json!({"id": "far", "geometry": {"type": "Point", "coordinates": [109, 17]}})),
            row(json!({"id": "near", "geometry": {"type": "Point", "coordinates": [108.001, 16]}})),
            row(json!({"id": "mid", "geometry": {"type": "Point", "coordinates": [108.02, 16]}})),
            row(json!({"id": "no-geometry"})),
        ];
        let result = near_hazards(
            &rows,
            &NearQuery {
                lat: 16.0,
                lng: 108.0,
                radius_m: 5_000.0,
                limit: 2,
                offset: 0,
            },
        );
        assert_eq!(
            result
                .items
                .iter()
                .map(|row| row["id"].clone())
                .collect::<Vec<_>>(),
            vec![json!("near"), json!("mid")]
        );
        assert_eq!(result.total, 2);
        assert!(
            result.items[0]["distance_m"].as_i64().unwrap()
                < result.items[1]["distance_m"].as_i64().unwrap()
        );
    }

    #[test]
    fn in_polygon_results_include_only_contained_points() {
        let area = validate_polygon(&json!({
            "type": "Polygon",
            "coordinates": [[[107.5, 15.5], [108.5, 15.5], [108.5, 16.5], [107.5, 16.5], [107.5, 15.5]]]
        }))
        .expect("valid polygon");
        let rows = vec![
            row(json!({"id": "inside", "geometry": {"type": "Point", "coordinates": [108, 16]}})),
            row(json!({"id": "outside", "geometry": {"type": "Point", "coordinates": [109, 17]}})),
        ];
        let result = in_polygon_hazards(&rows, &area, 100, 0);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0]["id"], json!("inside"));
        assert_eq!(result.total, 1);
    }
}
