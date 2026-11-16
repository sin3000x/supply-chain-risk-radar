# WorldMonitor upstream modules

Source: https://github.com/koala73/worldmonitor/tree/e5f9cff2fa9901a671c1ff0b36e71ebc5d9c35f1/shared

- `story-identity.js`: upstream normalization, similarity, and clustering. Only the SHA-256/HMAC calls were adapted to Node's built-in crypto; thresholds, tokenization, and clustering are unchanged.
- `publisher-families.js`, `syndication.js`: unchanged upstream publisher identity and syndicated-copy detection.
- `threat-keyword-classifier.ts`: unchanged upstream keyword classifier. Node strips its types at runtime.

See the repository root `LICENSE` for the upstream AGPL v3 license. Keep these notices when updating the snapshot.
