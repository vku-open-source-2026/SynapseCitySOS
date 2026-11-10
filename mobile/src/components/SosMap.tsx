// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import type { Hazard, MapConfig, NearbyShelter, PublicEmergencyEvent, Severity } from '../api/types';
import { firstPoint } from '../lib/geo';
import { colors, normalizeSeverity, severityMeta } from '../lib/format';
import type { AppLocation } from '../hooks/useLocation';
import { HazardRadar } from './HazardRadar';

interface SosMapProps {
  hazards: Hazard[];
  events: PublicEmergencyEvent[];
  shelters: NearbyShelter[];
  location: AppLocation;
  mapConfig?: MapConfig | null;
  showHazards?: boolean;
  showEvents?: boolean;
  showShelters?: boolean;
  onSelectHazard: (id: string) => void;
  onSelectEvent: (id: string) => void;
  height?: number;
  focusDataOnly?: boolean;
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function tileUrl(config: MapConfig | null | undefined): string {
  const raw = config?.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  if (raw.startsWith('/')) return `https://sos.synapsecity.sbs${raw}`;
  return raw;
}

function buildHtml(
  hazards: Array<{ id: string; title: string; severity: string; geometry: unknown; color: string }>,
  events: Array<{ id: string; title: string; lat: number; lng: number; severity: Severity }>,
  shelters: Array<{ id: string; name: string; lat: number; lng: number }>,
  location: { latitude: number; longitude: number },
  config: MapConfig | null | undefined,
  showHazards: boolean,
  showEvents: boolean,
  showShelters: boolean,
  focusDataOnly: boolean,
): string {
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
html,body,#map{height:100%;margin:0;background:#FFF8F3}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.leaflet-control-attribution{background:rgba(255,255,255,.88)!important;color:#A0847D!important;font-size:9px!important}
.leaflet-control-attribution a{color:#B9382B!important}
.leaflet-control-zoom a{background:#FFFFFF!important;color:#3F1D1A!important;border-color:#F1D9CC!important}
.user{width:16px;height:16px;border-radius:50%;background:#0E7490;border:3px solid #FFFFFF;box-shadow:0 0 0 8px rgba(14,116,144,.13)}
.event{width:18px;height:18px;transform:rotate(45deg);background:#F97316;border:2px solid #FFFFFF;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 7px rgba(63,29,26,.22)}
.event b{transform:rotate(-45deg);font:800 10px/1 sans-serif;color:#FFFFFF}
.shelter{width:22px;height:22px;border-radius:6px;background:#059669;border:2px solid #FFFFFF;display:flex;align-items:center;justify-content:center;color:#FFFFFF;font:800 11px/1 sans-serif;box-shadow:0 2px 7px rgba(63,29,26,.2)}
</style></head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var hazards=${escapeJson(hazards)};
var events=${escapeJson(events)};
var shelters=${escapeJson(shelters)};
var origin=${escapeJson(location)};
var map=L.map('map',{zoomControl:false,attributionControl:true}).setView([origin.latitude,origin.longitude],11);
L.tileLayer(${escapeJson(tileUrl(config))},{maxZoom:${Number(config?.maxZoom) || 20},attribution:${escapeJson(config?.attribution || '&copy; OpenStreetMap')}}).addTo(map);
L.control.zoom({position:'bottomright'}).addTo(map);
var focusDataOnly=${focusDataOnly ? 'true' : 'false'};
var bounds=focusDataOnly ? [] : [[origin.latitude,origin.longitude]];
if(!focusDataOnly){
L.circle([origin.latitude,origin.longitude],{radius:100000,color:'#C2412D',weight:1,opacity:.16,fillColor:'#C2412D',fillOpacity:.02}).addTo(map);
L.marker([origin.latitude,origin.longitude],{icon:L.divIcon({className:'',html:'<div class="user"></div>',iconSize:[16,16],iconAnchor:[8,8]}),interactive:false,zIndexOffset:1000}).addTo(map);
}

function addHazard(h){
  if(!h.geometry) return;
  var layer=L.geoJSON({type:'Feature',properties:{},geometry:h.geometry},{
    style:function(){return {color:h.color,weight:2,opacity:.9,fillColor:h.color,fillOpacity:.18}},
    pointToLayer:function(feature,latlng){return L.circleMarker(latlng,{radius:h.severity==='critical'?11:8,color:h.color,weight:2,fillColor:h.color,fillOpacity:.8})}
  }).addTo(map);
  layer.on('click',function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'hazard',id:h.id}))});
  try{var b=layer.getBounds(); if(b.isValid()) bounds.push(b.getCenter());}catch(e){}
}
function addEvent(e){
  var marker=L.marker([e.lat,e.lng],{icon:L.divIcon({className:'',html:'<div class="event"><b>!</b></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);
  marker.on('click',function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'event',id:e.id}))});
  bounds.push([e.lat,e.lng]);
}
function addShelter(s){
  var marker=L.marker([s.lat,s.lng],{icon:L.divIcon({className:'',html:'<div class="shelter">⌂</div>',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(map);
  bounds.push([s.lat,s.lng]);
}

if(${showHazards}) hazards.forEach(addHazard);
if(${showEvents}) events.forEach(addEvent);
if(${showShelters}) shelters.forEach(addShelter);
if(bounds.length>1){map.fitBounds(bounds,{padding:[44,44],maxZoom:14});}else if(focusDataOnly){map.setView([16.0544,108.2022],11);}
setTimeout(function(){map.invalidateSize();window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}))},180);
</script></body></html>`;
}

export function SosMap({
  hazards,
  events,
  shelters,
  location,
  mapConfig,
  showHazards = true,
  showEvents = true,
  showShelters = false,
  onSelectHazard,
  onSelectEvent,
  height = 440,
  focusDataOnly = false,
}: SosMapProps) {
  const webRef = useRef<React.ComponentRef<typeof WebView>>(null);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const hazardPayload = useMemo(
    () =>
      hazards
        .filter((hazard) => hazard.geometry)
        .map((hazard) => {
          const severity = normalizeSeverity(hazard.severity);
          return {
            id: hazard.id,
            title: hazard.title,
            severity,
            geometry: hazard.geometry,
            color: severityMeta[severity].color,
          };
        })
        .slice(0, 300),
    [hazards],
  );

  const eventPayload = useMemo(
    () =>
      events
        .map((event) => {
          const coordinates = firstPoint(event.geometry);
          if (!coordinates) return null;
          return {
            id: event.id,
            title: event.title,
            lat: coordinates.latitude,
            lng: coordinates.longitude,
            severity: normalizeSeverity(event.severity),
          };
        })
        .filter((entry): entry is { id: string; title: string; lat: number; lng: number; severity: Severity } => Boolean(entry))
        .slice(0, 100),
    [events],
  );

  const shelterPayload = useMemo(
    () =>
      shelters
        .map((shelter) => {
          const coordinates = firstPoint(shelter.current_location);
          if (!coordinates) return null;
          return { id: shelter.id, name: shelter.name, lat: coordinates.latitude, lng: coordinates.longitude };
        })
        .filter((entry): entry is { id: string; name: string; lat: number; lng: number } => Boolean(entry)),
    [shelters],
  );

  const html = useMemo(
    () =>
      buildHtml(
        hazardPayload,
        eventPayload,
        shelterPayload,
        { latitude: location.latitude, longitude: location.longitude },
        mapConfig,
        showHazards,
        showEvents,
        showShelters,
        focusDataOnly,
      ),
    [hazardPayload, eventPayload, shelterPayload, location.latitude, location.longitude, mapConfig, showHazards, showEvents, showShelters, focusDataOnly],
  );

  useEffect(() => {
    readyRef.current = false;
    setReady(false);
    setFailed(false);
    const timer = setTimeout(() => {
      if (!readyRef.current) setFailed(true);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [html]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data) as { type?: string; id?: string };
        if (message.type === 'ready') {
          readyRef.current = true;
          setReady(true);
        }
        if (message.type === 'hazard' && message.id) onSelectHazard(message.id);
        if (message.type === 'event' && message.id) onSelectEvent(message.id);
      } catch {
        // Ignore malformed map messages.
      }
    },
    [onSelectHazard, onSelectEvent],
  );

  const recenter = useCallback(() => {
    webRef.current?.injectJavaScript(
      `map.setView([${location.latitude},${location.longitude}],12,{animate:true}); true;`,
    );
  }, [location.latitude, location.longitude]);

  if (failed) {
    return (
      <View style={[styles.fallback, { height }]}>
        <HazardRadar location={location} hazards={hazards} events={events} size={Math.min(height - 40, 300)} />
        <Text style={styles.fallbackText}>
          Bản đồ trực tuyến không tải được. Đang hiển thị radar tương đối; dữ liệu cảnh báo vẫn lấy từ API.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrapper, { height }]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        style={styles.web}
      />
      {!ready ? (
        <View style={styles.loading} pointerEvents="none">
          <Text style={styles.loadingText}>Đang tải bản đồ cảnh báo…</Text>
        </View>
      ) : null}
      <TouchableOpacity style={styles.recenter} onPress={recenter} accessibilityLabel="Về vị trí của tôi">
        <Ionicons name="locate" size={20} color={colors.cyan} />
      </TouchableOpacity>
      <View style={styles.legend}>
        <Legend color={colors.red} label="Nguy hiểm" />
        <Legend color={colors.orange} label="Sự kiện" />
        <Legend color={colors.green} label="Trú ẩn" />
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { overflow: 'hidden', borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border },
  web: { flex: 1, backgroundColor: '#FFF8F3' },
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  recenter: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#3F1D1A',
    shadowOpacity: 0.10,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  legend: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.textMuted, fontSize: 9, fontWeight: '600' },
  fallback: {
    borderRadius: 20,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    gap: 10,
  },
  fallbackText: { color: colors.textMuted, fontSize: 11, textAlign: 'center' },
});
