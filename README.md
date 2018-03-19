# SyncPad

Allows sharing files in real-time and syncs SharpPad output. Useful for LAN presentations.

![SyncPad](https://thumbs.gfycat.com/IdolizedAjarBlackfish-size_restricted.gif)

Commands:

- syncpad.shareFile: Share current file or force refresh if already sharing.
- syncpad.stopSharing: Stop sharing all files.
- syncpad.joinSession: Join a session by address. Connections use socket.io over http.
- syncpad.openFiles: Open all files that are being shared in current session. Useful if you accidentally close documents.
- syncpad.disconnect: Leave currently joined session.

Extension is not yet published anywhere due to instability.
