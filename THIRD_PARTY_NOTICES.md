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
- **react-native-webrtc** — Copyright (c) 2017-present React Native WebRTC
  Community; Copyright (c) 2015-2017 Howard Yang. The RN bridge behind 1:1
  video calls (docs/VIDEO-CALLS.md); its bundled native WebRTC library is
  listed separately under BSD-3-Clause below.
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

## Apache-2.0-licensed components

- **jsQR** — Copyright (c) 2018 Cosmo Wolfe. The QR decoder behind "Scan
  their code"; distributed under the Apache License 2.0, the same license as
  this application (see LICENSE).

## BSD-3-Clause-licensed components

- **jpeg-js** — Copyright (c) 2014, Eugene Ware; portions Copyright 2011
  notmasteryet. Decodes the camera frame that "Scan their code"
  photographs.
- **WebRTC (libwebrtc)** — Copyright (c) 2011, The WebRTC project authors.
  The native library react-native-webrtc bundles into the APK/IPA (roughly
  30-45 MB per ABI): peer connections, the codecs, and the congestion
  control behind 1:1 video calls. Redistributed under its BSD 3-Clause
  license with the WebRTC project's additional patent grant (its PATENTS
  file); the library itself bundles further third-party components under
  their own compatible licenses.

Distributed under the 3-clause BSD License:

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from this
   software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## Model weights

The Playa Angel weights are downloaded by the app at the camper's request.
They are not in this repository and are not covered by the root Apache-2.0
license. They are published at
[huggingface.co/davidryalpug/playa-angel](https://huggingface.co/davidryalpug/playa-angel),
and the three tiers do not share one base model, so the license attaches per
file. `src/llm/modelCatalog.ts` pins the exact file each tier downloads.

- **Playa Angel Max** (`angel-max.gguf`) — a **modified** derivative of
  Google's **Gemma 4 E4B**: modified by fine-tuning and by Q4_0
  quantization. Distributed under the **Apache License 2.0**, the license
  Google releases Gemma 4 under (the base model's license tag at
  [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it)
  and [Google's Gemma 4 license page](https://ai.google.dev/gemma/apache_2)).
  The Apache 2.0 text ships beside the weights in the
  [distribution repository](https://huggingface.co/davidryalpug/playa-angel).
  Earlier revisions of this document cited the Gemma Terms of Use, which
  by their own appendix govern earlier Gemma generations, not Gemma 4.
  This project is not affiliated with or endorsed by Google.

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
