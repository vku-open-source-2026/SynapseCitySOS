// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.sos.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class SosWidgetHazard(
    val id: String,
    val title: String,
    val severity: String,
    val latitude: Double,
    val longitude: Double,
    val distanceM: Int,
)

data class SosWidgetEvent(
    val id: String,
    val title: String,
    val severity: String,
    val latitude: Double,
    val longitude: Double,
)

data class SosWidgetSnapshot(
    val generatedAt: Long,
    val latitude: Double,
    val longitude: Double,
    val locationLabel: String,
    val locationIsFallback: Boolean,
    val feedStatus: String,
    val feedLabel: String,
    val activeEvents: Int,
    val maxEventSeverity: String?,
    val nearestHazardId: String?,
    val nearestHazardTitle: String?,
    val nearestHazardSeverity: String?,
    val nearestHazardDistanceM: Int?,
    val hazards: List<SosWidgetHazard>,
    val events: List<SosWidgetEvent>,
    val online: Boolean,
) {
    fun toJson(): String {
        val root = JSONObject()
        root.put("generatedAt", generatedAt)
        root.put("latitude", latitude)
        root.put("longitude", longitude)
        root.put("locationLabel", locationLabel)
        root.put("locationIsFallback", locationIsFallback)
        root.put("feedStatus", feedStatus)
        root.put("feedLabel", feedLabel)
        root.put("activeEvents", activeEvents)
        root.put("maxEventSeverity", maxEventSeverity ?: JSONObject.NULL)
        root.put("nearestHazardId", nearestHazardId ?: JSONObject.NULL)
        root.put("nearestHazardTitle", nearestHazardTitle ?: JSONObject.NULL)
        root.put("nearestHazardSeverity", nearestHazardSeverity ?: JSONObject.NULL)
        root.put("nearestHazardDistanceM", nearestHazardDistanceM ?: JSONObject.NULL)
        root.put("online", online)
        val hazardArray = JSONArray()
        hazards.forEach {
            hazardArray.put(JSONObject().apply {
                put("id", it.id); put("title", it.title); put("severity", it.severity)
                put("latitude", it.latitude); put("longitude", it.longitude); put("distanceM", it.distanceM)
            })
        }
        root.put("hazards", hazardArray)
        val eventArray = JSONArray()
        events.forEach {
            eventArray.put(JSONObject().apply {
                put("id", it.id); put("title", it.title); put("severity", it.severity)
                put("latitude", it.latitude); put("longitude", it.longitude)
            })
        }
        root.put("events", eventArray)
        return root.toString()
    }

    companion object {
        fun fromJson(raw: String?): SosWidgetSnapshot? {
            if (raw.isNullOrBlank()) return null
            return try {
                val root = JSONObject(raw)
                val hazards = mutableListOf<SosWidgetHazard>()
                val hRows = root.optJSONArray("hazards") ?: JSONArray()
                for (i in 0 until hRows.length()) {
                    val item = hRows.optJSONObject(i) ?: continue
                    hazards.add(
                        SosWidgetHazard(
                            item.optString("id"), item.optString("title"), item.optString("severity", "medium"),
                            item.optDouble("latitude"), item.optDouble("longitude"), item.optInt("distanceM"),
                        ),
                    )
                }
                val events = mutableListOf<SosWidgetEvent>()
                val eRows = root.optJSONArray("events") ?: JSONArray()
                for (i in 0 until eRows.length()) {
                    val item = eRows.optJSONObject(i) ?: continue
                    events.add(
                        SosWidgetEvent(
                            item.optString("id"), item.optString("title"), item.optString("severity", "medium"),
                            item.optDouble("latitude"), item.optDouble("longitude"),
                        ),
                    )
                }
                SosWidgetSnapshot(
                    generatedAt = root.optLong("generatedAt"),
                    latitude = root.optDouble("latitude", 16.0544),
                    longitude = root.optDouble("longitude", 108.2022),
                    locationLabel = root.optString("locationLabel", "Đà Nẵng · mặc định"),
                    locationIsFallback = root.optBoolean("locationIsFallback", true),
                    feedStatus = root.optString("feedStatus", "unknown"),
                    feedLabel = root.optString("feedLabel", "Không xác định nguồn tin"),
                    activeEvents = root.optInt("activeEvents"),
                    maxEventSeverity = root.optString("maxEventSeverity").takeIf { it.isNotBlank() && it != "null" },
                    nearestHazardId = root.optString("nearestHazardId").takeIf { it.isNotBlank() && it != "null" },
                    nearestHazardTitle = root.optString("nearestHazardTitle").takeIf { it.isNotBlank() && it != "null" },
                    nearestHazardSeverity = root.optString("nearestHazardSeverity").takeIf { it.isNotBlank() && it != "null" },
                    nearestHazardDistanceM = root.optInt("nearestHazardDistanceM", -1).takeIf { it >= 0 },
                    hazards = hazards,
                    events = events,
                    online = root.optBoolean("online", true),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}

object SosWidgetStore {
    private const val PREFS = "synapsecitysos_widget"
    private const val KEY_SNAPSHOT = "snapshot"
    private const val KEY_LAST_NOTIFIED = "last_notified_hazard"

    fun load(context: Context): SosWidgetSnapshot? =
        SosWidgetSnapshot.fromJson(
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SNAPSHOT, null),
        )

    fun save(context: Context, snapshot: SosWidgetSnapshot) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_SNAPSHOT, snapshot.toJson()).apply()
    }

    fun saveRaw(context: Context, raw: String): SosWidgetSnapshot? {
        val parsed = SosWidgetSnapshot.fromJson(raw) ?: return null
        save(context, parsed)
        return parsed
    }

    fun markOffline(context: Context): SosWidgetSnapshot? {
        val current = load(context) ?: return null
        val next = current.copy(online = false)
        save(context, next)
        return next
    }

    fun lastNotified(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LAST_NOTIFIED, null)

    fun setLastNotified(context: Context, id: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_LAST_NOTIFIED, id).apply()
    }
}
