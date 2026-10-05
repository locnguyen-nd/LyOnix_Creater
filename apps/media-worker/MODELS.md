# media-worker detector models (VE2E-66)

Models are NOT in git. `corepack pnpm --filter @lyonix/media-worker models:download` fetches them into `data/models/`
(or `REFRAME_MODELS_DIR`), verifies the SHA-256 pinned in `src/reframe/models.ts` and writes `MODELS-LICENSES.txt`.
All come from the OpenCV Zoo (https://github.com/opencv/opencv_zoo). YOLOv8/Ultralytics is not used (AGPL-3.0).

| Role | File | Size | SHA-256 | License |
|---|---|---|---|---|
| Face | face_detection_yunet_2023mar.onnx | 232,589 | 8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4 | MIT |
| Person | object_detection_yolox_2022nov.onnx | 35,858,002 | c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063 | Apache-2.0 |
| Text | text_detection_cn_ppocrv3_2023may.onnx | 2,423,490 | 03f550c6b406fda8bf54bd8327815f6c7e2edd98cea02348c93d879254366587 | Apache-2.0 |

The OpenCV Zoo `en` text model is byte-identical to the `cn` one. A missing/corrupt file fails the job with `MODEL_NOT_AVAILABLE`.
