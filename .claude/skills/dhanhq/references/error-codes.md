# Error Codes — Complete Reference

SDK note:
- on HTTP failure, the current Python SDK maps raw Dhan error payloads into:

```python
{
    "status": "failure",
    "remarks": {
        "error_code": "...",
        "error_type": "...",
        "error_message": "..."
    },
    "data": ""
}
```

- on success, `response["data"]` contains the raw endpoint payload.

## Trading API Errors

From the current v2 annexure:

| Type | Code | Meaning |
|------|------|---------|
| Invalid Authentication | `DH-901` | Client ID or access token is invalid or expired |
| Invalid Access | `DH-902` | User does not have required Data API or Trading API access |
| User Account | `DH-903` | Account setup issue, segment activation, or related account requirement |
| Rate Limit | `DH-904` | Rate limit exceeded |
| Input Exception | `DH-905` | Missing or invalid request fields |
| Order Error | `DH-906` | Order request cannot be processed |
| Data Error | `DH-907` | Data unavailable or parameters invalid |
| Internal Server Error | `DH-908` | Server-side failure |
| Network Error | `DH-909` | Backend communication failure |
| Others | `DH-910` | Other failure reason |
| Invalid IP | `DH-911` | Static IP invalid or not whitelisted |

## Data API Errors

From the current v2 annexure:

| Code | Meaning |
|------|---------|
| `800` | Internal Server Error |
| `804` | Requested number of instruments exceeds limit |
| `805` | Too many requests or connections |
| `806` | Data APIs not subscribed |
| `807` | Access token is expired |
| `808` | Authentication failed - client ID or access token invalid |
| `809` | Access token is invalid |
| `810` | Client ID is invalid |
| `811` | Invalid expiry date |
| `812` | Invalid date format |
| `813` | Invalid security ID |
| `814` | Invalid request |

## Decision Tree

### If the error is `807`, `808`, `809`, or `810`

Fix authentication first:
- refresh or regenerate token
- verify client ID
- retry only after credentials are corrected

### If the error is `806` or `DH-902`

Treat it as access/subscription first:
- check `dataPlan`
- check `dataValidity`
- verify the account has the right API access

### If the error is `DH-911`

Treat it as a trading infrastructure issue:
- check static IP setup
- verify the request is coming from the whitelisted IP

### If the error is `DH-905` or `DH-906`

Treat it as a request-shape or order-validation problem:
- product type
- lot size
- trigger/price fields
- segment
- security ID

## Data API Subscription Invalid — User Playbook

When the user gets `DH-902` or `806`, do this:

1. Log in to `web.dhan.co`
2. Open `My Profile` -> `Access DhanHQ APIs`
3. Check whether `dataPlan` is active
4. If not active, subscribe/activate the Data API plan
5. Generate a fresh access token
6. Verify `dataValidity`
7. Re-test a simple snapshot call such as `ticker_data()` or `ohlc_data()`

If order APIs still fail after that:
- this is a separate issue
- check static IP setup next

## Retry Guidance

Safe to retry automatically:
- `DH-904`
- `800`
- `805`
- rare transient `DH-908` / `DH-909`

Do not blindly retry:
- `DH-901`
- `DH-902`
- `DH-905`
- `DH-906`
- `DH-911`
- `806`
- `807`
- `808`
- `809`
- `810`
- `811`
- `812`
- `813`
- `814`

## Rate Limits

Current documented rate limits:

| API Category | Per Second | Per Minute | Per Hour | Per Day |
|-------------|-----------:|-----------:|---------:|--------:|
| Order APIs | 10 | 250 | 1000 | 7000 |
| Data APIs | 5 | - | - | 100000 |
| Quote APIs | 1 | Unlimited | Unlimited | Unlimited |
| Non-Trading APIs | 20 | Unlimited | Unlimited | Unlimited |

## Practical Rule

Never use the error code alone without endpoint context.

Examples:
- `805` on WebSocket can mean too many live connections
- `805` on data calls can mean request throttling
- `DH-902` can surface when the user expects quotes/history but only has trading access
