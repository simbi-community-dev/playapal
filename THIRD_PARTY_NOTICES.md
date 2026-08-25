# Third-party notices

This application is licensed under Apache-2.0 (see LICENSE). The files and
packages below carry their own licenses, reproduced or referenced here.
`android/gradlew` and `android/gradlew.bat` refer to their own license: that
is the MIT license of the React Native template, below — not the root
Apache-2.0 file.

## MIT-licensed components

- **React Native (application template files, including android/gradlew, android/gradlew.bat, ios project scaffolding)** — Copyright (c) Meta Platforms, Inc. and affiliates.
- **react-native-quick-sqlite (patched in patches/)** — Copyright (c) 2021 Oscar Franco
- **@op-engineering/op-sqlite** — Copyright (c) Oscar Franco
- **llama.rn (patched in patches/)** — Copyright (c) 2023 BRICKS Studio
- **react-native-sensors (patched in patches/)** — Copyright (c) 2016 Daniel Schmidt
- **@mhpdev/react-native-speech (patched in patches/)** — Copyright (c) MHP Dev
- **react-native-image-picker** — Copyright (c) 2015-present, Facebook, Inc.
- **fflate** — Copyright (c) 2026 Arjun Barrett

Each of the above is distributed under the MIT License:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Model weights

The Playa Angel weights are downloaded by the app at the camper's request.
They are not in this repository and are not covered by the root Apache-2.0
license. They are published at
[huggingface.co/davidryalpug/playa-angel](https://huggingface.co/davidryalpug/playa-angel),
and the three tiers do not share one base model, so the license attaches per
file. `src/llm/modelCatalog.ts` pins the exact file each tier downloads.

- **Playa Angel Max** (`angel-max.gguf`) — a fine-tuned, quantized derivative
  of Google's **Gemma 4 E4B**, and therefore a Model Derivative under the
  [Gemma Terms of Use](https://ai.google.dev/gemma/terms). Those terms carry
  use restrictions (§3.2, which incorporates the
  [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy))
  that apply to anyone who uses or redistributes this file. The base weights
  were modified by fine-tuning and by quantization. Google claims no rights
  in generated output (§3.3) and grants no trademark rights (§4.2); this
  project is not affiliated with or endorsed by Google. Required notice:

```
Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms
```

- **Playa Angel** (`angel-smart.gguf`) and **Playa Angel Light**
  (`angel-light.gguf`) — one fine-tuned derivative of **LFM2.5** by Liquid AI
  at two quantizations (Q4_0 and Q3_K_M), under the **LFM Open License
  v1.0**, which conditions commercial use on an annual revenue threshold.
  That condition applies to any use of the derivative weights.

The two schemes attach to different files and do not conflict. No single
license covers all three tiers. Per-file detail is in `NOTICE`; the reasoning
is in `docs/LICENSING.md`.

## Data provenance

- City geometry: `assets/city-geo/geometry.json` (2026) is DERIVED by
  `tools/build_city_geo.py` from Burning Man Project's published 2026 city
  data — the 2026 BRC Measurements document and the official GIS map data
  (github.com/burningmantech/innovate-GIS-data; toilet-bank centroids come
  directly from its toilets GeoJSON) — used under the Terms of Service for
  Burning Man APIs and Datasets (participant projects, non-commercial),
  plus NOAA WMM-2025 declination (US-government public domain). Full
  per-number citations, hashes, and retrieval dates:
  `assets/city-geo/PROVENANCE.md`. The app still fails closed to its
  geometry-free compass floor if the bundled geometry is wrong-year.
- Bundled pack provenance and credits: see NOTICE and each pack's
  per-file credit lines. Content checksums: `assets/packs/SHA256SUMS`.
