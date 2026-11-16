// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.sos.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent

class SosWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        appWidgetIds.forEach { SosWidgetRenderer.render(context, it) }
        SosWidgetWorker.schedulePeriodic(context)
        if (SosWidgetStore.load(context) == null) SosWidgetWorker.enqueueOneTime(context)
    }

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        SosWidgetWorker.schedulePeriodic(context)
        SosWidgetWorker.enqueueOneTime(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            SosWidgetWorker.enqueueOneTime(context)
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
            if (id != -1) SosWidgetRenderer.render(context, id)
        }
    }

    companion object {
        const val ACTION_REFRESH = "sbs.synapsecity.sos.widget.REFRESH"

        fun updateAll(context: Context) {
            SosWidgetRenderer.updateAll(context)
        }
    }
}
