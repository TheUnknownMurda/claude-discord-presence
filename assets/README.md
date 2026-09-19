# Assets

This folder is for the image(s) your Discord Rich Presence shows.

## The default: an art-asset key

`claude.png` in this folder is the image uploaded to the shared Discord app under
the art-asset key **`claude`**, which is what `presence.largeImage` points at by
default. Discord only renders images it hosts itself, so the local file here is
just the source art — the copy Discord shows lives in the Developer Portal.

## Using your own app / your own art

In the **Discord Developer Portal → your app → Rich Presence → Art Assets**,
upload your images and reference them by the key you gave them:

| Asset key | Used for |
|---|---|
| `claude` | the large icon |
| `active` | small overlay when Claude is focused (optional) |
| `idle` | small overlay when Claude is backgrounded (optional) |

Then set `"largeImage": "claude"` (and `smallImageActive` / `smallImageIdle` if
you uploaded overlays). Keys must match exactly, and only apply to the app whose
ID is in `clientId`. Freshly-uploaded assets can take a few minutes to appear.

> Note: a raw `https://` image URL in these fields does **not** render — Discord
> requires assets it hosts (or media-proxy `mp:` paths), so upload the image.
