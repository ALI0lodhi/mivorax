# Courier booking (PostEx) — setup

Each order in **Admin → Orders** has a **Courier · PostEx** panel with a **Book with PostEx** button.
One click sends the customer's name, phone, address and city, the number of items, the order number
and the amount to collect to PostEx, then saves the PostEx tracking number on the order.

The button stays off until a PostEx token is present in the server settings.

## Turn it on

1. In your PostEx merchant portal, copy your **API token**.
2. In `server/.env`:
   ```
   POSTEX_API_TOKEN=your-token
   POSTEX_PICKUP_ADDRESS_CODE=      # optional, see below
   ```
3. Restart the server. The panel now shows the booking button.

`POSTEX_PICKUP_ADDRESS_CODE` selects which of your PostEx pickup addresses the parcel is collected from.
Leave it empty to use your account's default. `POSTEX_STORE_ADDRESS_CODE` works the same way for store addresses.

## What gets sent

| PostEx field | Value |
|---|---|
| customerName, deliveryAddress | from the order |
| customerPhone | the order's phone converted to `03xxxxxxxxx` (a number that can't be converted blocks the booking with a clear message) |
| cityName | the customer's city, matched to PostEx's own list of delivery cities |
| items | total pieces in the order |
| orderDetail | product names, sizes and quantities |
| orderRefNumber | the store order number (`MVX-…`) |
| invoicePayment | order total for cash on delivery, `0` for orders already paid online |

PostEx's order API has no email field, so the customer's email is not sent.

## Good to know

- **City:** if the customer's city can't be matched to a PostEx city, the panel asks you to choose one from PostEx's list before booking.
- **No double booking:** an order can only be booked once. **Cancel booking** cancels it at PostEx and lets you book again.
- **Which orders:** only confirmed or processing orders can be booked (not unpaid online orders). Booking moves a confirmed order to processing and fills in the courier and tracking number.
- **Pickup:** the parcel is created in your PostEx account. If your account doesn't auto-book pickups, confirm the pickup in the PostEx portal.
