// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.sos.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import android.widget.RemoteViews
import sbs.synapsecity.sos.MainActivity
import sbs.synapsecity.sos.R
import java.util.concurrent.TimeUnit
import kotlin.math.cos

object SosWidgetRenderer {
    fun render(context: Context, appWidgetId: Int) {
        val snapshot = SosWidgetStore.load(context)
        val views = RemoteViews(context.packageName, R.layout.sos_widget)
        val ageMinutes = snapshot?.let {
            TimeUnit.MILLISECONDS.toMinutes(System.currentTimeMillis() - it.generatedAt).coerceAtLeast(0)
        } ?: Long.MAX_VALUE
        val stale = snapshot == null || !snapshot.online || ageMinutes > 30
        val unknown = snapshot == null || !snapshot.online || snapshot.feedStatus != "ok"

        views.setTextViewText(R.id.sos_widget_feed, context.getString(R.string.sos_widget_unknown))
        views.setTextColor(R.id.sos_widget_feed, Color.parseColor("#B45309"))
        views.setTextViewText(R.id.sos_widget_hazard, context.getString(R.string.sos_widget_no_data))
        views.setTextViewText(R.id.sos_widget_meta, context.getString(R.string.sos_widget_no_data_hint))
        views.setTextViewText(R.id.sos_widget_events, "")
        views.setTextViewText(R.id.sos_widget_footer, context.getString(R.string.sos_widget_waiting))
        views.setOnClickPendingIntent(
            R.id.sos_widget_root,
            openApp(context, "synapsecitysos://sos", appWidgetId * 10 + 1),
        )

        if (snapshot != null) {
            views.setTextViewText(
                R.id.sos_widget_feed,
                if (unknown) context.getString(R.string.sos_widget_unknown) else context.getString(R.string.sos_widget_feed_ok),
            )
            views.setTextColor(R.id.sos_widget_feed, Color.parseColor(if (unknown) "#B45309" else "#047857"))
            views.setTextViewText(R.id.sos_widget_feed_dot, "●")
            views.setTextColor(R.id.sos_widget_feed_dot, Color.parseColor(if (unknown) "#B45309" else "#047857"))
            views.setTextViewText(
                R.id.sos_widget_hazard,
                snapshot.nearestHazardTitle ?: context.getString(R.string.sos_widget_no_hazard),
            )
            val severity = severityLabel(snapshot.nearestHazardSeverity)
            val distance = snapshot.nearestHazardDistanceM?.let { formatDistance(it) }
            val meta = if (distance != null) {
                if (stale) "$severity · $distance · ${context.getString(R.string.sos_widget_stale)}" else "$severity · $distance"
            } else {
                context.getString(R.string.sos_widget_no_hazard)
            }
            views.setTextViewText(R.id.sos_widget_meta, meta)
            views.setTextViewText(
                R.id.sos_widget_events,
                context.getString(R.string.sos_widget_events, snapshot.activeEvents, severityLabel(snapshot.maxEventSeverity)),
            )
            views.setTextViewText(
                R.id.sos_widget_footer,
                if (stale) context.getString(R.string.sos_widget_stale_footer, ageMinutes.coerceAtMost(9999))
                else context.getString(R.string.sos_widget_updated, ageMinutes.coerceAtMost(9999)),
            )
            val id = snapshot.nearestHazardId
            if (id != null) {
                views.setOnClickPendingIntent(
                    R.id.sos_widget_root,
                    openApp(context, "synapsecitysos://hazard/${Uri.encode(id)}", appWidgetId * 10 + 1),
                )
                views.setOnClickPendingIntent(
                    R.id.sos_widget_map,
                    openApp(context, "synapsecitysos://hazard/${Uri.encode(id)}", appWidgetId * 10 + 2),
                )
            }
        } else {
            views.setTextViewText(R.id.sos_widget_feed_dot, "●")
            views.setTextColor(R.id.sos_widget_feed_dot, Color.parseColor("#D97706"))
        }

        views.setImageViewBitmap(R.id.sos_widget_map, drawMap(snapshot))
        views.setOnClickPendingIntent(
            R.id.sos_widget_sos,
            openApp(context, "synapsecitysos://sos", appWidgetId * 10 + 3),
        )
        views.setOnClickPendingIntent(R.id.sos_widget_refresh, refreshIntent(context, appWidgetId))
        AppWidgetManager.getInstance(context).updateAppWidget(appWidgetId, views)
    }

    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, SosWidgetProvider::class.java))
        ids.forEach { render(context, it) }
    }

    private fun openApp(context: Context, uri: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri), context, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun refreshIntent(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, SosWidgetProvider::class.java).apply {
            action = SosWidgetProvider.ACTION_REFRESH
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        }
        return PendingIntent.getBroadcast(
            context, appWidgetId * 10 + 4, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun severityLabel(severity: String?): String = when (severity) {
        "critical" -> "Nghiêm trọng"
        "high" -> "Cao"
        "medium" -> "Trung bình"
        "low" -> "Thấp"
        else -> "Chưa rõ"
    }

    private fun formatDistance(meters: Int): String =
        if (meters < 950) "${(meters / 10) * 10} m" else String.format("%.1f km", meters / 1000.0)

    private fun drawMap(snapshot: SosWidgetSnapshot?): Bitmap {
        val size = 320
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val clip = Path().apply {
            addRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 28f, 28f, Path.Direction.CW)
        }
        canvas.clipPath(clip)
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(
                0f, 0f, size.toFloat(), size.toFloat(),
                Color.parseColor("#FFF1EA"), Color.parseColor("#FFFFFF"), Shader.TileMode.CLAMP,
            )
        }
        canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), bg)
        val center = size / 2f
        val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 2f; color = Color.argb(55, 194, 65, 45)
        }
        canvas.drawCircle(center, center, size * 0.46f, ring)
        canvas.drawCircle(center, center, size * 0.30f, ring)
        canvas.drawCircle(center, center, size * 0.15f, ring)
        val axis = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(75, 241, 225, 216); strokeWidth = 1.5f }
        canvas.drawLine(center, size * 0.05f, center, size * 0.95f, axis)
        canvas.drawLine(size * 0.05f, center, size * 0.95f, center, axis)

        val lat = snapshot?.latitude ?: SosWidgetWorker.DEFAULT_LAT
        val lng = snapshot?.longitude ?: SosWidgetWorker.DEFAULT_LNG
        val maxPx = size * 0.44f
        val mPerLat = 111_320.0
        val mPerLng = mPerLat * cos(Math.toRadians(lat))
        snapshot?.hazards?.forEach { hazard ->
            val dx = (hazard.longitude - lng) * mPerLng
            val dy = -(hazard.latitude - lat) * mPerLat
            if (kotlin.math.sqrt(dx * dx + dy * dy) > 100_000) return@forEach
            val scale = maxPx / 100_000.0
            val x = center + (dx * scale).toFloat()
            val y = center + (dy * scale).toFloat()
            val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor(severityColor(hazard.severity)) }
            val radius = if (hazard.id == snapshot.nearestHazardId) 9f else 6f
            canvas.drawCircle(x, y, radius, dot)
            val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor("#FFFFFF"); style = Paint.Style.STROKE; strokeWidth = 2f
            }
            canvas.drawCircle(x, y, radius, outline)
        }
        snapshot?.events?.forEach { event ->
            val dx = (event.longitude - lng) * mPerLng
            val dy = -(event.latitude - lat) * mPerLat
            if (kotlin.math.sqrt(dx * dx + dy * dy) > 100_000) return@forEach
            val scale = maxPx / 100_000.0
            val x = center + (dx * scale).toFloat()
            val y = center + (dy * scale).toFloat()
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#F97316") }
            val rect = RectF(x - 5f, y - 5f, x + 5f, y + 5f)
            canvas.save()
            canvas.rotate(45f, x, y)
            canvas.drawRect(rect, paint)
            canvas.restore()
        }
        val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(45, 14, 116, 144) }
        canvas.drawCircle(center, center, 19f, halo)
        val user = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#0E7490") }
        canvas.drawCircle(center, center, 10f, user)
        val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#FFFFFF"); style = Paint.Style.STROKE; strokeWidth = 3f
        }
        canvas.drawCircle(center, center, 10f, outline)
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#A0847D"); textSize = 18f; isFakeBoldText = true
        }
        canvas.drawText("B", center - 6f, 24f, text)
        canvas.drawText(if (snapshot?.locationIsFallback == false) "GPS" else "ĐN", 14f, size - 14f, text)
        canvas.drawText("100 km", size - 78f, size - 14f, text)
        return bitmap
    }

    private fun severityColor(severity: String): String = when (severity) {
        "critical" -> "#BE123C"
        "high" -> "#C2410C"
        "medium" -> "#B45309"
        else -> "#047857"
    }
}
