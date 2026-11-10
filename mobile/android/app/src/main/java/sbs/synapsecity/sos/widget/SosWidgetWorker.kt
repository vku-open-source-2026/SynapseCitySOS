// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.sos.widget

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject
import sbs.synapsecity.sos.MainActivity
import sbs.synapsecity.sos.R

class SosWidgetWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val previous = SosWidgetStore.load(applicationContext)
        val latitude = previous?.latitude ?: DEFAULT_LAT
        val longitude = previous?.longitude ?: DEFAULT_LNG
        val label = previous?.locationLabel ?: "Đà Nẵng · mặc định"
        val fallback = previous?.locationIsFallback ?: true

        return try {
            val status = JSONObject(get(STATUS_URL))
            val hazardRows = JSONArray(get(HAZARDS_URL))
            val eventRows = JSONArray(get(EVENTS_URL))
            val hazards = mutableListOf<SosWidgetHazard>()
            var nearest: SosWidgetHazard? = null
            var nearestDistance = Double.MAX_VALUE
            for (i in 0 until hazardRows.length()) {
                val item = hazardRows.optJSONObject(i) ?: continue
                if (!item.optBoolean("is_active", true) || item.optString("status") == "expired") continue
                val coordinates = coordinatesOf(item.optJSONObject("geometry")) ?: continue
                val distance = distanceMeters(latitude, longitude, coordinates.first, coordinates.second)
                if (distance > NEARBY_RADIUS_M) continue
                val hazard = SosWidgetHazard(
                    id = item.optString("id"),
                    title = item.optString("title", "Cảnh báo thiên tai"),
                    severity = item.optString("severity", "medium"),
                    latitude = coordinates.first,
                    longitude = coordinates.second,
                    distanceM = distance.toInt(),
                )
                hazards.add(hazard)
                if (distance < nearestDistance) { nearest = hazard; nearestDistance = distance }
            }
            hazards.sortBy { it.distanceM }

            val events = mutableListOf<SosWidgetEvent>()
            var maxEventSeverity: String? = null
            var maxRank = 0
            for (i in 0 until eventRows.length()) {
                val item = eventRows.optJSONObject(i) ?: continue
                val severity = item.optString("severity", "medium")
                val rank = severityRank(severity)
                if (rank > maxRank) { maxRank = rank; maxEventSeverity = severity }
                val coordinates = coordinatesOf(item.optJSONObject("geometry")) ?: continue
                events.add(
                    SosWidgetEvent(
                        id = item.optString("id"),
                        title = item.optString("title", "Sự kiện khẩn cấp"),
                        severity = severity,
                        latitude = coordinates.first,
                        longitude = coordinates.second,
                    ),
                )
            }

            val feed = status.optJSONObject("hazard_feed")
            val feedOk = status.optBoolean("data_available", false) &&
                status.optString("status") == "ok" && feed != null &&
                !feed.optBoolean("stale", true) &&
                feed.optString("status") !in setOf("error", "stale", "unconfigured")
            val snapshot = SosWidgetSnapshot(
                generatedAt = System.currentTimeMillis(),
                latitude = latitude,
                longitude = longitude,
                locationLabel = label,
                locationIsFallback = fallback,
                feedStatus = if (feedOk) "ok" else "unknown",
                feedLabel = if (feedOk) "Nguồn tin hoạt động" else "Không xác định nguồn tin",
                activeEvents = events.size,
                maxEventSeverity = maxEventSeverity,
                nearestHazardId = nearest?.id,
                nearestHazardTitle = nearest?.title,
                nearestHazardSeverity = nearest?.severity,
                nearestHazardDistanceM = nearest?.distanceM,
                hazards = hazards.take(20),
                events = events.take(20),
                online = true,
            )
            SosWidgetStore.save(applicationContext, snapshot)
            SosWidgetProvider.updateAll(applicationContext)
            maybeNotify(nearest)
            Result.success()
        } catch (_: Exception) {
            SosWidgetStore.markOffline(applicationContext)
            SosWidgetProvider.updateAll(applicationContext)
            Result.success()
        }
    }

    private fun maybeNotify(nearest: SosWidgetHazard?) {
        if (nearest == null || severityRank(nearest.severity) < 3) return
        if (SosWidgetStore.lastNotified(applicationContext) == nearest.id) return
        SosWidgetStore.setLastNotified(applicationContext, nearest.id)
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Cảnh báo thiên tai", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Cảnh báo thiên tai nghiêm trọng từ SynapseSOS"
            },
        )
        if (!NotificationManagerCompat.from(applicationContext).areNotificationsEnabled()) return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("synapsecitysos://hazard/${nearest.id}"), applicationContext, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(
            applicationContext, nearest.id.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.notification_icon)
            .setContentTitle(if (nearest.severity == "critical") "Cảnh báo thiên tai nghiêm trọng" else "Cảnh báo thiên tai mới")
            .setContentText(nearest.title)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        NotificationManagerCompat.from(applicationContext).notify(nearest.id.hashCode(), notification)
    }

    private fun get(url: String): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "SynapseSOSWidget/0.1 (Android)")
            if (connection.responseCode !in 200..299) error("HTTP ${connection.responseCode}")
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun coordinatesOf(geometry: JSONObject?): Pair<Double, Double>? =
        walk(geometry?.optJSONArray("coordinates"))

    private fun walk(value: JSONArray?): Pair<Double, Double>? {
        if (value == null || value.length() < 2) return null
        if (value.opt(0) is Number && value.opt(1) is Number) {
            return value.optDouble(1) to value.optDouble(0)
        }
        for (i in 0 until value.length()) {
            val child = value.optJSONArray(i) ?: continue
            walk(child)?.let { return it }
        }
        return null
    }

    private fun severityRank(value: String): Int = when (value) {
        "critical" -> 4
        "high" -> 3
        "medium" -> 2
        else -> 1
    }

    private fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val earth = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * earth * atan2(sqrt(a), sqrt(1 - a))
    }

    companion object {
        const val DEFAULT_LAT = 16.0544
        const val DEFAULT_LNG = 108.2022
        private const val NEARBY_RADIUS_M = 100_000.0
        private const val STATUS_URL = "https://sos.synapsecity.sbs/v1/emergency/public/status"
        private const val HAZARDS_URL = "https://sos.synapsecity.sbs/v1/hazards?limit=300"
        private const val EVENTS_URL = "https://sos.synapsecity.sbs/v1/emergency/public?limit=100"
        private const val CHANNEL_ID = "sos-alerts"
        private const val PERIODIC_NAME = "sos-widget-periodic"
        private const val ONE_TIME_NAME = "sos-widget-refresh"

        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<SosWidgetWorker>(30, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, request,
            )
        }

        fun enqueueOneTime(context: Context) {
            // No network constraint: an offline refresh must still run so the
            // widget can mark its cached snapshot as stale instead of silently
            // doing nothing.
            val request = OneTimeWorkRequestBuilder<SosWidgetWorker>()
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONE_TIME_NAME, ExistingWorkPolicy.REPLACE, request,
            )
        }
    }
}
