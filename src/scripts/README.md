# Operational scripts

## Profiling

Configure the client once:

```sh
export ADMIN_URL='http://127.0.0.1:5001'
export ADMIN_API_KEY='replace-me'
export PROFILE_DIR="$PWD/profiles"
mkdir -p "$PROFILE_DIR"
```

Capture a 30-second CPU profile:

```sh
npm run pprof -- capture profile \
  --output "$PROFILE_DIR/cpu.pprof.gz"
```

Capture CPU for a custom duration:

```sh
npm run pprof -- capture profile \
  --seconds 45 \
  --output "$PROFILE_DIR/cpu-45s.pprof.gz"
```

Capture a 30-second sampled heap profile:

```sh
npm run pprof -- capture heap \
  --output "$PROFILE_DIR/heap.pprof.gz"
```

Capture a full V8 heap snapshot:

```sh
npm run pprof -- capture heap-snapshot \
  --output "$PROFILE_DIR/heap.heapsnapshot"
```

Generate HTML and Markdown Flame artifacts in addition to the pprof file:

```sh
npm run pprof -- capture profile \
  --output "$PROFILE_DIR/cpu.pprof.gz" \
  --flame

npm run pprof -- capture heap \
  --output "$PROFILE_DIR/heap.pprof.gz" \
  --flame
```

Manual CPU and sampled-heap captures use one synchronous HTTP request. Keep `--seconds` below every proxy or load-balancer idle timeout (default is 60s). Each request profiles only its serving isolate. When `PROFILING_S3_BUCKET` is configured, CPU and sampled-heap captures are also archived as class `manual`.

List today's automatically captured CPU profiles from API processes (UTC):

```sh
npm run pprof -- list \
  --class auto \
  --service api \
  --kind cpu \
  --limit 20
```

List automatically captured CPU profiles from queue workers:

```sh
npm run pprof -- list \
  --class auto \
  --service worker \
  --kind cpu \
  --limit 20
```

List manual sampled-heap profiles:

```sh
npm run pprof -- list \
  --class manual \
  --kind heap \
  --limit 20
```

List profiles captured yesterday or two days ago (UTC):

```sh
npm run pprof -- list --class auto --days-ago 1
npm run pprof -- list --class auto --days-ago 2
```

List profiles from an exact UTC date:

```sh
npm run pprof -- list \
  --class auto \
  --date 2026-07-12
```

List every retained profile in global newest-first order:

```sh
npm run pprof -- list \
  --class auto \
  --all
```

Fetch the next list page using the `cursor` returned by the previous command:

```sh
export PROFILE_CURSOR='paste-cursor-here'

npm run pprof -- list \
  --class auto \
  --service api \
  --kind cpu \
  --limit 20 \
  --cursor "$PROFILE_CURSOR"
```

Repeat the same `--date`, `--days-ago`, or `--all` selector when using a cursor. Without one of these options, `list` defaults to the current UTC date.

Inspect one profile using an `id` returned by `list`:

```sh
export PROFILE_ID='paste-profile-id-here'
npm run pprof -- detail "$PROFILE_ID"
```

Download one profile:

```sh
export PROFILE_ID='paste-profile-id-here'

npm run pprof -- download "$PROFILE_ID" \
  --output "$PROFILE_DIR/downloaded.pprof.gz"
```

Download one profile and generate Flame artifacts:

```sh
export PROFILE_ID='paste-profile-id-here'

npm run pprof -- download "$PROFILE_ID" \
  --output "$PROFILE_DIR/downloaded.pprof.gz" \
  --flame
```

The reverse timestamp and capture identity are the first key component after class, so S3 returns profiles in global newest-first order across services, kinds, and dates. The remaining key contains service, kind, reason, hostname, process/build provenance, and Watt application/worker ids when available. Date bounds and other filters are applied while scanning S3; no database or secondary object index is required. Stored-profile list and detail output expose the same provenance fields. Use a separate profiling bucket for each deployment environment.

## Offline pprof analysis

Run these commands from a checkout of the same build that produced the profile. `-trim_path=/app -source_path="$PWD"` maps deployed `/app/src/...` or `/app/dist/...` paths to the matching local source files.

Show the largest flat CPU consumers:

```sh
export PROFILE="$PROFILE_DIR/cpu.pprof.gz"

go tool pprof \
  -trim_path=/app \
  -source_path="$PWD" \
  -top \
  "$PROFILE"
```

Show the largest cumulative CPU call paths:

```sh
export PROFILE="$PROFILE_DIR/cpu.pprof.gz"

go tool pprof \
  -trim_path=/app \
  -source_path="$PWD" \
  -cum \
  -top \
  "$PROFILE"
```

Open Go's interactive web UI, then select **View > Flame Graph**:

```sh
export PROFILE="$PROFILE_DIR/cpu.pprof.gz"

go tool pprof \
  -trim_path=/app \
  -source_path="$PWD" \
  -http=127.0.0.1:8080 \
  "$PROFILE"
```

Show annotated local source for matching functions:

```sh
export PROFILE="$PROFILE_DIR/cpu.pprof.gz"

go tool pprof \
  -trim_path=/app \
  -source_path="$PWD" \
  -list='getObjectInfo|findObject' \
  "$PROFILE"
```

Analyze retained heap bytes:

```sh
export PROFILE="$PROFILE_DIR/heap.pprof.gz"

go tool pprof \
  -trim_path=/app \
  -source_path="$PWD" \
  -sample_index=inuse_space \
  -top \
  "$PROFILE"
```

Compare a current profile against a baseline:

```sh
export BASELINE="$PROFILE_DIR/cpu-baseline.pprof.gz"
export PROFILE="$PROFILE_DIR/cpu-current.pprof.gz"

go tool pprof \
  -trim_path=/app \
  -source_path="$PWD" \
  -diff_base="$BASELINE" \
  -top \
  "$PROFILE"
```

`go tool pprof` does not read V8 `.heapsnapshot` files. Open those in Chrome DevTools under **Memory > Load**.
