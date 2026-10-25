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
| `deviceModel` | yes | The model string the operating system reports for the phone. A marketing name is not required. |
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
  "deviceModel": "the flat field, or the metadata model when the flat field is absent",
  "camera": "the flat field, or the metadata camera when the flat field is absent",
  "captureWidth": 0,
  "captureHeight": 0,
  "pxPerMm": 0
}
```

`pxPerMm` is the server's measurement: the card's height in the uploaded image, in pixels, divided by 88.9 mm. The server ignores any px/mm the phone sends. A warp that upsamples a small card does not raise this number.

## How an edge is labeled

A claimed tolerance has to cover at least 3 pixels, the border finder's smallest distinct step.

| Achieved px/mm | Solid edge | Fine-print edge |
|---|---|---|
| 30 or more | ±0.1 mm | fine-print, ±0.2 mm |
| 15 up to 30 | ±0.2 mm | fine-print, ±0.2 mm |
| below 15 | withheld, resolution | withheld, resolution |

Unknown px/mm keeps the flatbed rule: ±0.1 mm, or ±0.2 mm when the answer key marks that edge fine-print. Measured millimetres stay on the report either way. A withheld edge is not scored as a wrong grade.

## When a device is trusted

Step 4 groups fronts by device model, camera, and capture pixel size, and prints the px/mm range inside the group. A group is trusted at ±0.1 mm only when every front in it supports that resolution and every scored edge lands on the flatbed key (0.1 mm, or 0.2 mm on a fine-print edge). Otherwise the group is ±0.2 mm when the edges still land inside 0.2 mm, or not trusted. A phone or capture mode is not trusted until that proof exists.
