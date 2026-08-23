# K2 SE Browser Slicer

A local-first slicer and simple CAD workspace for the Creality K2 SE. Create a basic part or upload an STL/3MF, arrange it on the printer plate, choose PLA settings, slice, inspect the layers, and download G-code without installing a desktop slicer.

**Use it online:** [mailtojaykanchan-del.github.io/k2-se-browser-slicer](https://mailtojaykanchan-del.github.io/k2-se-browser-slicer/)

Real slicing is performed in the browser by the open-source Kiri:Moto engine. Model data stays in the browser and is not uploaded to a slicing service. The engine, worker, and WebAssembly helper are bundled with this project, so slicing has no runtime dependency on Grid.Space or another remote service.

## K2 SE Profile

- Build volume: `220 x 215 x 245 mm`
- Filament: `1.75 mm`
- Nozzle: `0.4 mm`
- Nozzle maximum: `300 C`
- Bed maximum: `100 C`
- G-code flavor: generic Klipper-style, single filament
- CFS: not used

The generated start and end G-code is deliberately generic. Compare the first output with a known-good Creality K2 SE profile and run a small supervised test print before relying on it for long jobs.

## Run Locally

Requirements: Node.js 22.13 or newer and pnpm. No desktop slicer is required.

```bash
corepack enable
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`.

## Production Build

```bash
pnpm build
pnpm start
```

Open `http://127.0.0.1:8787`.

The production Node server only serves the built web app. Browser slicing does not require the optional native slicing API.

## Deploy Online

The browser engine makes the main app deployable as a static site. Build with `pnpm build`, then publish the `dist` directory to Cloudflare Pages, Netlify, Vercel, or another static host. This project also includes a Sites deployment build through `pnpm build:site`.

### GitHub Pages

The repository includes `.github/workflows/deploy-pages.yml`. For a public GitHub repository, open **Settings > Pages**, set the source to **GitHub Actions**, and run the workflow. Future pushes to `main` publish automatically. The Vite build uses relative URLs so the slicer engine, worker, and WebAssembly files work from a GitHub Pages project address.

Docker is also supported:

```bash
docker build -t k2-se-browser-slicer .
docker run --rm -p 8787:8787 k2-se-browser-slicer
```

The `dist` directory includes the slicing engine under `kiri/` and its WebAssembly helper under `wasm/`. Keep those paths together when deploying. Once the site itself is available, slicing does not require an internet connection.

## Features

- CAD mode with editable boxes, cylinders, spheres, cones, and tubes
- AI CAD workspace with optional local Gemma 3 1B generation through WebGPU and no API key
- Connect touching or slightly overlapping solids into one movable, exportable, printable compound
- CAD STL export plus isometric, top, front, and right camera views
- Dedicated Convert workspace for local CAD-to-STL, CAD-to-3MF, STL-to-3MF, and 3MF-to-STL conversion
- STL upload and browser preview
- 3MF upload and preview when its geometry can be parsed
- Orbit, pan, and zoom
- Move, rotate, scale, center, lay-flat, reset, duplicate, delete, and auto-arrange
- Model dimensions and K2 SE plate/height validation
- PLA layer height, walls, top/bottom layers, infill, supports, brim/skirt, temperatures, speeds, nozzle, filament diameter, and flow
- Real browser-based slicing with no installed slicer
- Parsed layer preview, print-time estimate, and filament estimate
- Local G-code download

## Optional Native Backend

The original PrusaSlicer/SuperSlicer wrapper remains available for development or server-side workflows. Run `pnpm dev:full` and set `PRUSASLICER_BIN` only if you explicitly want that optional API. The browser UI does not require it.

Kiri:Moto is an open-source Grid.Space project distributed under the MIT license. The bundled license is in `public/kiri/LICENSE.md`. See the [Kiri:Moto documentation](https://docs.grid.space/kiri-moto/) and [GridSpace/grid-apps repository](https://github.com/GridSpace/grid-apps).

The optional AI CAD model runs locally through Transformers.js and needs a one-time model download. It tries fast WebGPU first and automatically retries with the slower CPU/WASM backend when WebGPU is unavailable. On static hosts such as GitHub Pages, the CPU fallback uses single-threaded WASM so it does not require cross-origin isolation or `SharedArrayBuffer`. AI generation stays disabled until Gemma is ready, so fallback geometry is never presented as model-generated output.
