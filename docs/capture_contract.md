# Capture contract

Any phone app that grades a card through this server uploads the same fields.
The iPhone app sends them today. An Android app sends the same fields later.
The server reads these fields and nothing that exists on only one platform.
It does not require a vendor camera name, a platform file container, or a
platform JSON shape, and it does not assume a pixel size chosen in advance.

`POST /api/grade` as `multipart/form-data`.

## What the upload contains

| Field | Required for a deck proof | Meaning |
|---|---|---|
| `image` | yes | The full-resolution still. The bytes are the image the quad refers to. Do not downscale it before upload. JPEG is the interchange format. |
| `cardQuad` | yes | JSON `{tl, tr, br, bl}`, each corner `[x, y]` in that image's pixel coordinates. Origin is the top left of the upright image. |
| `quadImageWidth`, `quadImageHeight` | yes | Pixel width and height of the image `cardQuad` was measured on. They match the uploaded still. |
| `deviceModel` | yes | The model string the operating system reports. The phone sends that string. The server stores a marketing name when the string is in its identifier table (`iPhone14,2` is stored as iPhone 13 Pro) and stores the reported string otherwise. An Android name such as `Pixel 8`, or a model code such as `SM-S911U`, is kept as reported until a code is added to the table. |
| `camera` | yes | Which camera took the still, named by the app. The same phone's other cameras use a different string. |
| `captureWidth`, `captureHeight` | yes | Pixel width and height of the uploaded still. |
| `capturePitch`, `captureRoll` | yes | Tilt in degrees at the shutter. |
| `captureLevel` | yes | `true` when the app treated the phone as level. |
| `side` | yes | `front` or `back`. |
| `deckId` | yes for a deck card | Deck id (`TD-01` …). Omit on a scan that is not part of the deck. |
| `centeringResolution` | yes for a full-resolution grade | `full`. The server then measures the card at that card's own pixel height. Omitting the field keeps the capped warp. |
| `captureMetadata` | no | Optional diagnostic JSON. The server stores it and does not grade from it. Flat fields above are the contract. |

`scanId`, `pairId`, and the other existing form fields stay as they are.

## What the server records

On each saved scan, and on a card-not-found line, `capture` is:

```json
{
  "deviceModel": "marketing name when the table knows the identifier, otherwise the reported string",
  "camera": "the flat field, or the metadata camera when the flat field is absent",
  "captureWidth": 0,
  "captureHeight": 0,
  "pxPerMm": 0
}
```

`pxPerMm` is the server's measurement: the card's height in the uploaded image, in pixels, divided by 88.9 mm. The server ignores any px/mm the phone sends. A warp that upsamples a small card does not raise this number. A known Apple identifier is also written back onto `captureMetadata.device`: `model` becomes the marketing name and `modelIdentifier` keeps the string the phone sent. The same pass runs for scans already on disk the next time the server starts.

## A 12 MP still, and how close to hold the phone

The scanning phone is an iPhone 13 Pro. Its identifier is `iPhone14,2`. The wide camera's largest still is 4032×3024, and capture uses the largest still that camera reports. `8064×6048` is the iPhone 14 Pro (`iPhone15,2`) 48 MP still, used when that camera is the one reporting its sizes.

The upload is the card quad plus a margin, cut from that full still at the still's own pixels. The crop keeps those pixels. Background stays on all four sides. The quad is in the cropped image's coordinates, and `quadImageWidth` / `quadImageHeight` match the JPEG that is uploaded. The phone sends `centeringResolution` `full`, so the server measures that card at its own pixel height. A request that omits the field stays on the capped warp, and the millimetres of scans already saved do not move.

A card that fills the long side of the 4032×3024 still is 4032 / 88.9 = 45.4 px/mm. On this phone that distance is closer than the lens stays sharp. The measured sharp band for the iPhone 13 Pro wide camera is 29–31 px/mm, about 11 cm. The phone shows live px/mm from the on-screen card quad and the words move closer, hold, or too close. The shutter opens only inside that band, and only after focus has settled and the card edge is sharp. The measured band is data for one device and one camera. A device with no measurement uses a conservative default band from the long side of the still that camera reports: the far end is 15 px/mm when the still can show it, and the close end is 70% of a card that fills that long side. The shutter opens inside that band once focus has settled and the edge check passes. A still size that has not been reported leaves the distance open, and the shutter still opens once focus and the edge check pass. The phone records `capture.sharpBand` as `measured`, `default`, or `open`. The server stores that token and does not grade from it.

## How an edge is labeled

The label follows that scan's achieved px/mm. 30.0 px/mm is on the line: it is ±0.1 mm. 29.9 px/mm is ±0.2 mm. Below 15 px/mm the edge is withheld. Each scan keeps the label its own px/mm produces. 30 px/mm stays the line. Every graded scan with a measured px/mm is appended to `data/sharp_band_log.jsonl` with the device, camera, capture size, px/mm, label, and band token, so a band can be learned per device. The log is not a grade.

A claimed tolerance has to cover at least 3 pixels, the border finder's smallest distinct step.

| Achieved px/mm | Solid edge | Fine-print edge |
|---|---|---|
| 30 or more | ±0.1 mm | fine-print, ±0.2 mm |
| 15 up to 30 | ±0.2 mm | fine-print, ±0.2 mm |
| below 15 | withheld, resolution | withheld, resolution |

Unknown px/mm keeps the flatbed rule: ±0.1 mm, or ±0.2 mm when the answer key marks that edge fine-print. Measured millimetres stay on the report either way. A withheld edge is not scored as a wrong grade.

## When a device is trusted

Step 4 groups fronts by device model, camera, and capture pixel size, and prints the px/mm range inside the group. A group is trusted at ±0.1 mm only when every front in it supports that resolution and every scored edge lands on the flatbed key (0.1 mm, or 0.2 mm on a fine-print edge). Otherwise the group is ±0.2 mm when the edges still land inside 0.2 mm, or not trusted. A phone or capture mode is not trusted until that proof exists.
