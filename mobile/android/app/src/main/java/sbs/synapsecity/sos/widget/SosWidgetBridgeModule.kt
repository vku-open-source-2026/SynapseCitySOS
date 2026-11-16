// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.sos.widget

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SosWidgetBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "WidgetBridge"

    @ReactMethod
    fun sync(snapshotJson: String) {
        val snapshot = SosWidgetStore.saveRaw(reactApplicationContext, snapshotJson) ?: return
        SosWidgetProvider.updateAll(reactApplicationContext)
        if (!snapshot.online) SosWidgetWorker.enqueueOneTime(reactApplicationContext)
    }

    @ReactMethod
    fun refresh() {
        SosWidgetWorker.enqueueOneTime(reactApplicationContext)
    }
}
