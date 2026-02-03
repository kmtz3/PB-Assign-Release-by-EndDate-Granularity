# Productboard Release Auto-Assignment Service

Automatically assigns Productboard features to weekly, monthly, quarterly, and yearly releases based on feature end dates.

## Overview

This service:
- Receives webhooks from Productboard when feature timeframes change
- Automatically assigns features to the appropriate release in each granularity (weekly/monthly/quarterly/yearly)
- Seeds future releases on-demand via admin endpoint
- Handles missing/inaccessible release groups gracefully

## Features

- ✅ **Async webhook processing** - Fast response times prevent timeout duplicates
- ✅ **Graceful degradation** - Continues if some release groups fail
- ✅ **Feedback loop prevention** - Ignores assignment-triggered webhooks
- ✅ **Flexible quarterly anchors** - Support for fiscal years
- ✅ **Structured logging** - JSON logs for production, pretty logs for development
- ✅ **UTC-normalized** - Day-only semantics, no timezone drift
- ✅ **Authenticated endpoints** - Bearer token protection for webhook and admin endpoints

## Prerequisites

- Node.js 20+ (recommended: use the version in Dockerfile)
- Productboard account with API access
- Release groups created in Productboard for:
  - Weekly releases
  - Monthly releases
  - Quarterly releases
  - Yearly releases

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Required: Productboard API token (starts with "pbp_")
PRODUCTBOARD_API_TOKEN=pbp_your_token_here

# Required: Webhook and admin authentication (shared secret)
# Used in Authorization header: "Bearer <token>"
PB_WEBHOOK_AUTH=super-secret-shared

# Required: Release group IDs (UUIDs from Productboard)
RELEASE_GROUP_WEEKLY_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
RELEASE_GROUP_MONTHLY_ID=bbbbbbbb-cccc-dddd-eeee-ffffffffffff
RELEASE_GROUP_QUARTERLY_ID=cccccccc-dddd-eeee-ffff-000000000000
RELEASE_GROUP_YEARLY_ID=dddddddd-eeee-ffff-0000-111111111111

# Optional: Quarterly anchor month (1=Jan, 8=Aug, etc.)
QUARTER_START_MONTH=1

# Optional: Server port
PORT=8080

# Optional: Enable debug logging
PB_DEBUG=1
```

### 3. Run the Service

**Development mode** (with auto-reload and pretty logs):
```bash
npm run dev
```

**Production mode**:
```bash
npm start
```

### 4. Configure Productboard Webhook

1. Go to Productboard Settings → Integrations → Webhooks
2. Create a new webhook:
   - **URL**: `https://your-service.com/pb-webhook`
   - **Events**: `feature.created`, `feature.updated`
   - **Authentication**: Add header `Authorization: Bearer super-secret-shared`
3. Test the webhook with a feature timeframe change

## API Endpoints

### POST `/pb-webhook`

Receives Productboard webhooks for feature changes.

**Authentication**: Bearer token via `Authorization` header

**Request**: Productboard webhook payload

**Response**:
- `200 OK` - Accepted for processing
- `204 No Content` - Ignored (no event type, non-feature event, no timeframe change)
- `400 Bad Request` - Missing feature ID
- `401 Unauthorized` - Invalid authentication

**Headers**:
- `X-Request-ID` - Correlation ID for request tracing

**Example**:
```bash
curl -X POST http://localhost:8080/pb-webhook \
  -H "Authorization: Bearer super-secret-shared" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "eventType": "feature.updated",
      "id": "feature-uuid",
      "updatedAttributes": ["timeframe"]
    }
  }'
```

### POST `/admin/seed-releases`

Seeds future releases for all granularities.

**Authentication**: Bearer token via `Authorization` header

**Request**: Empty body

**Response**:
```json
{
  "status": "success",
  "rangeStart": "2026-02-03T00:00:00.000Z",
  "rangeEnd": "2027-02-03T23:59:59.999Z",
  "summary": {
    "totalGroups": 4,
    "successfulGroups": 4,
    "failedGroups": 0,
    "createdCount": 142,
    "failedCreations": 0
  },
  "groups": {
    "weekly": { "status": "success", "created": 52 },
    "monthly": { "status": "success", "created": 12 },
    "quarterly": { "status": "success", "created": 4 },
    "yearly": { "status": "success", "created": 5 }
  },
  "createdNames": ["2030", "2029", ...]
}
```

**Status codes**:
- `200 OK` - Success or partial success
- `401 Unauthorized` - Invalid authentication
- `424 Failed Dependency` - All release groups failed to fetch
- `500 Internal Server Error` - Unexpected error

**Example**:
```bash
curl -X POST http://localhost:8080/admin/seed-releases \
  -H "Authorization: Bearer super-secret-shared"
```

## Deployment

### Docker

Build and run locally:

```bash
docker build -t pb-release-auto-assign .
docker run -p 8080:8080 --env-file .env pb-release-auto-assign
```

### Google Cloud Run

Deploy via Cloud Build (automatic on push to main):

```bash
gcloud builds submit --config cloudbuild.yaml
```

Or manually:

```bash
# Build
docker build -t gcr.io/PROJECT_ID/pb-release-auto-assign .
docker push gcr.io/PROJECT_ID/pb-release-auto-assign

# Deploy
gcloud run deploy pb-assign-release-by-enddate-granularity \
  --image gcr.io/PROJECT_ID/pb-release-auto-assign \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars PRODUCTBOARD_API_TOKEN=pbp_xxx,PB_WEBHOOK_AUTH=xxx,...
```

## Troubleshooting

### Webhook not processing

**Check logs for**:
```
Unauthorized request
```
**Solution**: Verify `PB_WEBHOOK_AUTH` matches webhook configuration in Productboard

---

**Check logs for**:
```
Ignoring update without timeframe change
```
**Solution**: This is normal - webhook is working, but feature didn't have timeframe updated

---

**Check logs for**:
```
🎯 weekly: no matching release for end=2026-05-15
```
**Solution**: Run seeder to create missing releases: `POST /admin/seed-releases`

### Feature assigned to wrong release

**Enable debug logging**:
```bash
export PB_DEBUG=1
npm start
```

Check debug output for available release timeframes. Verify feature end date falls within expected release timeframe (closed interval, day-only).

### Seeder failing

**Check logs for**:
```
❗ Missing release group IDs: yearly
```
**Solution**: Add missing env var `RELEASE_GROUP_YEARLY_ID`

---

**Check logs for**:
```
⏭️  Skipped weekly: Release group not found (404)
```
**Solution**: Verify release group UUID exists in Productboard

---

**Check response for**:
```json
{
  "status": "partial_success",
  "failedCreations": [
    { "name": "Feb week 1 2026", "error": "API rate limit exceeded" }
  ]
}
```
**Solution**: Rate limit hit - wait and retry, or contact Productboard support

### Duplicate webhooks

**Check logs for**:
```
✅ Webhook accepted for processing (22500 ms)
```
**Solution**: If response time > 20s, Productboard may retry. This was fixed with async processing. Ensure you're running latest version.

### Memory issues

**Check Cloud Run logs for**: Memory limit errors

**Solution**: Increase memory allocation in Cloud Run:
```bash
gcloud run services update pb-assign-release-by-enddate-granularity \
  --memory 512Mi \
  --region europe-west1
```

### Viewing structured logs

**Production (JSON format)**:
```bash
NODE_ENV=production npm start
```
Logs will be in JSON format for machine parsing.

**Development (pretty format)**:
```bash
NODE_ENV=development npm start
```
Logs will be colorized and human-readable.

**Request correlation**: Check `X-Request-ID` header in responses and `requestId` field in logs to trace requests through async processing.

## Architecture

### Components

1. **Webhook Endpoint** (`/pb-webhook`) - Receives Productboard events
2. **Async Processor** (`processWebhookAsync`) - Handles feature assignment
3. **Seeder Endpoint** (`/admin/seed-releases`) - Creates future releases
4. **Period Builders** - Generate weekly/monthly/quarterly/yearly periods
5. **API Client** - Wraps Productboard API v2

### Flow

```
Productboard → Webhook → Auth → Validation → 200 OK (immediate)
                                           ↓
                                     Async Processing
                                           ↓
                                  Fetch Feature + Releases
                                           ↓
                               Assign to Matching Release
                                           ↓
                                  Unassign from Others
```

### Date Logic

- **UTC normalization**: All dates normalized to UTC day boundaries
- **Closed intervals**: Both start and end dates are inclusive
- **Day-only semantics**: Times are ignored, only dates matter
- **Week numbering**: Weeks start Monday, numbered within month
- **Quarter anchoring**: Configurable fiscal year support via `QUARTER_START_MONTH`

### Logging

- **Structured logs**: JSON format in production with timestamps, request IDs, log levels
- **Pretty logs**: Human-readable format in development with colors and emojis
- **Request correlation**: `X-Request-ID` header and `requestId` field track requests across async operations
- **Debug mode**: Enable with `PB_DEBUG=1` or `LOG_LEVEL=debug`

## Security

- **Authentication**: Bearer token required for webhook and admin endpoints
- **Audit logging**: Unauthorized attempts logged with endpoint, IP, and truncated auth token
- **Non-root container**: Docker runs as `appuser` (not root)
- **Environment-based secrets**: No hardcoded credentials

## Contributing

### Code Style

- ES modules (`import`/`export`)
- Async/await (no callbacks)
- Descriptive variable names
- Comments for complex logic

### Before Committing

1. Test changes locally with both dev and production logging modes
2. Verify authentication still works
3. Check that webhook and seeder endpoints function correctly
4. Update documentation if adding features

## License

Proprietary - Klara Martinez / Productboard

## Support

For issues or questions:
- Enable debug logging: `PB_DEBUG=1`
- Check `X-Request-ID` header for request tracing
- Review troubleshooting section above
- Check structured logs for detailed error information
