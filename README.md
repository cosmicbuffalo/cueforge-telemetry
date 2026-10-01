# cueforge-telemetry

The operational telemetry contract between the
[`comfyui-mobile-frontend`](https://github.com/cosmicbuffalo/comfyui-mobile-frontend)
custom node and the CueForge relay — and the exact code the relay runs on every
batch it receives.

It exists so you do not have to take the node's privacy doc on trust. The node
is open source, so you can read what it sends. The relay is not, so this is the
part of it that handles telemetry, published on its own.

## What is here

| File | What it is |
| --- | --- |
| [`contract.json`](./contract.json) | Every event the node may send, every field each may carry, and the allowed values or pattern for each field. **Anything not listed is dropped.** |
| [`src/index.ts`](./src/index.ts) | `validateBatch` and `forwardToPostHog`: the relay's whole handling of a batch. |
| [`src/index.test.ts`](./src/index.test.ts) | What is kept, what is dropped, and what is refused outright. |
| [`TELEMETRY.md`](./TELEMETRY.md) | What each event and number means in PostHog, and what it cannot tell you. |

The relay's `/telemetry/batch` route calls `validateBatch` on the request body,
answers `202`, then calls `forwardToPostHog` with the result. That is all it
does. It stores nothing and does not log the body.

## What the relay does with a batch

1. **Refuses** it outright unless `install_id` is a random UUIDv4, `deployment`
   is `dev`, `review` or `prod`, and it holds 1–50 events in at most 32 KB.
2. **Drops** any event whose name is not in `contract.json`, or whose timestamp
   is more than 7 days old or 10 minutes in the future.
3. **Drops** any field the contract does not list for that event, and any value
   that breaks its rule — a free-text string where an enum is expected, an
   exact count where only a range is allowed, an exception message where only a
   type name is allowed.
4. **Forwards** what is left to PostHog, adding `product: node`,
   `component: server` and the batch's `deployment`, with geolocation and person
   profiles disabled. PostHog receives the request from the relay, so it never
   sees the node's IP address.

Per-IP and per-install rate limits sit in front of this, in the relay itself.

## Who reads `contract.json`

- **The relay** imports this package, pinned to a tag.
- **The node** ships a copy as `telemetry_contract.json` and builds its own
  checks from it, so it never queues a field the relay would drop. Its tests fail
  if that copy differs from this file, and if its `CUEFORGE_PRIVACY.md` stops
  describing exactly what the contract allows.

## Changing it

Change `contract.json` here, tag a release, bump the relay's dependency, and
copy the file into the node. Add a field to the node's privacy doc in the same
change, or the node's tests fail.

> This repository is private while CueForge is in development, and will be made
> public before launch.

## Licence

[MIT](./LICENSE), the same as comfyui-mobile-frontend.
