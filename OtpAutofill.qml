import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
  id: root
  required property var appearance
  property bool ready: false
  property var offer: null
  property string buffer: ""
  property double now: Date.now()
  property var waitingCode: null
  property double waitingDeadline: 0
  OtpRuntime { id: runtime }
  function receive(code) {
    if (!root.enabled || !code) return
    if (!root.ready) { waitingCode = code; waitingDeadline = Date.now() + 300000; return }
    helper.write(JSON.stringify({ type: "code", code: code.code, key: code.key,
      domain: code.domain || "", remainingMs: 300000 }) + "\n")
  }
  function choose() {
    if (!offer || now >= offer.deadline) return
    helper.write(JSON.stringify({ type: "accept", id: offer.id }) + "\n")
    offer = null
  }
  function dismiss() {
    if (offer) helper.write(JSON.stringify({ type: "dismiss", id: offer.id }) + "\n")
    offer = null
  }
  Process {
    id: helper
    command: [runtime.executable, decodeURIComponent(Qt.resolvedUrl("otp-autofill.ts").toString().replace(/^file:\/\//, ""))]
    clearEnvironment: true
    environment: ({ HOME: Quickshell.env("HOME"), XDG_RUNTIME_DIR: Quickshell.env("XDG_RUNTIME_DIR"),
      HYPRLAND_INSTANCE_SIGNATURE: Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE"),
      XDG_SESSION_ID: Quickshell.env("XDG_SESSION_ID"), DBUS_SESSION_BUS_ADDRESS: Quickshell.env("DBUS_SESSION_BUS_ADDRESS"),
      DISPLAY: Quickshell.env("DISPLAY"), WAYLAND_DISPLAY: Quickshell.env("WAYLAND_DISPLAY"), PATH: "/usr/bin:/bin" })
    running: root.enabled
    stdinEnabled: true
    stdout: SplitParser {
      splitMarker: ""
      onRead: data => {
        // The child emits only small view models, never code text, to QML.
        for (var i = 0; i < data.length; i++) {
          if (data[i] === "\n") {
            try {
              var e = JSON.parse(root.buffer)
              if (e.type === "ready") {
                root.ready = true
                if (root.waitingCode && root.waitingDeadline > Date.now()) {
                  helper.write(JSON.stringify({ type: "code", code: root.waitingCode.code,
                    key: root.waitingCode.key, domain: root.waitingCode.domain || "",
                    remainingMs: root.waitingDeadline - Date.now() }) + "\n")
                }
                root.waitingCode = null
              }
              else if (e.type === "hide") root.offer = null
              else if (e.type === "offer" && typeof e.id === "string" && e.id.length <= 64
                && (e.mode === "smart" || e.mode === "manual") && e.deadline > Date.now()
                && e.deadline <= Date.now() + 300000
                && (!e.anchor || [e.anchor.x, e.anchor.y, e.anchor.w, e.anchor.h].every(n => typeof n === "number" && isFinite(n) && Math.abs(n) <= 32768) && e.anchor.w > 0 && e.anchor.h > 0) && /^[a-zA-Z0-9_.:-]{0,64}$/.test(e.monitor)) root.offer = e
            } catch (e) { root.offer = null }
            root.buffer = ""
          } else {
            if (root.buffer.length >= 4096) { helper.signal(15); return }
            root.buffer += data[i]
          }
        }
      }
    }
    onExited: {
      root.ready = false; root.offer = null; root.buffer = ""
      // A dead helper would leave autofill off until the next shell restart.
      if (root.enabled) respawn.restart()
    }
  }
  Timer {
    id: respawn
    property int attempts: 0
    interval: Math.min(60000, 5000 * Math.pow(2, attempts))
    onTriggered: {
      if (!root.enabled || helper.running) return
      attempts = Math.min(attempts + 1, 4)
      helper.running = Qt.binding(() => root.enabled)
    }
  }
  onReadyChanged: if (ready) respawn.attempts = 0
  Timer {
    interval: 200; repeat: true; running: root.offer !== null
    onTriggered: { root.now = Date.now(); if (root.offer && root.now >= root.offer.deadline) root.offer = null }
  }
  Timer {
    interval: 500; repeat: true; running: root.waitingCode !== null
    onTriggered: if (!root.enabled || root.waitingDeadline <= Date.now()) root.waitingCode = null
  }
  PanelWindow {
    id: prompt
    visible: root.enabled && root.offer !== null
    screen: Quickshell.screens.find(s => root.offer && s.name === root.offer.monitor) || Quickshell.screens[0]
    anchors { top: true; left: true }
    readonly property var fieldAnchor: root.offer ? root.offer.anchor : null
    readonly property real outputWidth: screen ? screen.width : 1920
    readonly property real outputHeight: screen ? screen.height : 1080
    margins.left: Math.round(Math.max(12, Math.min(outputWidth - implicitWidth - 12,
      fieldAnchor ? fieldAnchor.x : outputWidth - implicitWidth - 24)))
    margins.top: Math.round(Math.max(12, Math.min(outputHeight - implicitHeight - 12,
      fieldAnchor ? (fieldAnchor.y + fieldAnchor.h + 8 + implicitHeight <= outputHeight - 12
        ? fieldAnchor.y + fieldAnchor.h + 8 : fieldAnchor.y - implicitHeight - 8) : 48)))
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "blip-otp-autofill"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    color: "transparent"
    implicitWidth: row.implicitWidth + 24
    implicitHeight: row.implicitHeight + 20
    Rectangle {
      anchors.fill: parent
      color: root.appearance.background
      radius: root.appearance.cornerRadius
      border.width: root.appearance.borderWidth
      border.color: root.appearance.muted
      RowLayout {
        id: row
        anchors.centerIn: parent
        spacing: 12
        Text {
          text: "󰭹"; textFormat: Text.PlainText
          color: root.appearance.accent; font.family: root.appearance.fontFamily; font.pixelSize: 24
        }
        ColumnLayout {
          spacing: 3
          Text {
            text: "Blip · Verification code"; textFormat: Text.PlainText
            color: root.appearance.foreground; font.family: root.appearance.fontFamily; font.pixelSize: root.appearance.fontBody
          }
          Text {
            text: root.offer && root.offer.mode === "smart" ? "Ready for this field" : "Select a field, then fill"
            textFormat: Text.PlainText
            color: root.appearance.muted; font.family: root.appearance.fontFamily; font.pixelSize: root.appearance.fontBodySmall
          }
        }
        Button {
          text: "Fill code"; fontFamily: root.appearance.fontFamily; fontSize: root.appearance.fontBody
          accent: root.appearance.accent; foreground: root.appearance.accentText; background: root.appearance.accent
          focusable: false; onClicked: root.choose()
        }
        Button {
          text: "×"; fontFamily: root.appearance.fontFamily; fontSize: root.appearance.fontBody; focusable: false
          tooltipText: "Dismiss this code"; onClicked: root.dismiss()
        }
      }
    }
  }
  Component.onDestruction: helper.signal(15)
}
