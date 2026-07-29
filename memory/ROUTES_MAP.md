# Route File → Endpoint Map (generated)

> **GENERATED — do not hand-edit.** Regenerate with `npm run routes-map` after adding or
> moving a route; the previous hand-maintained version drifted to 44 of 121 files.
> Paths are resolved from `server.js`'s actual `app.use()` mounts, so they are the real
> URLs, not the in-file relative paths.
>
> Generated 2026-07-29 · **121 route files · 722 endpoints**

## Endpoints by file

### A

**admin-rbac.js** — 6 endpoints

- `DELETE /api/admin-rbac/pages`
- `GET    /api/admin-rbac/pages`
- `PUT    /api/admin-rbac/pages`
- `DELETE /api/admin-rbac/roles`
- `GET    /api/admin-rbac/roles`
- `PUT    /api/admin-rbac/roles`

**ae-dashboard.js** — 6 endpoints

- `GET    /api/ae-dashboard/data-quality`
- `GET    /api/ae-dashboard/due-dates`
- `GET    /api/ae-dashboard/growth`
- `GET    /api/ae-dashboard/purchasing`
- `GET    /api/ae-dashboard/purchasing-all`
- `GET    /api/ae-dashboard/summary`

**art.js** — 27 endpoints

- `GET    /api/art-charges`
- `POST   /api/art-charges`
- `GET    /api/art-invoices`
- `POST   /api/art-invoices`
- `DELETE /api/art-invoices/:id`
- `GET    /api/art-invoices/:id`
- `PUT    /api/art-invoices/:id`
- `GET    /api/art-notifications`
- `POST   /api/art-notifications`
- `GET    /api/art-requests/:designId/analysis`
- `DELETE /api/art-requests/:designId/analysis/:mockupSlot`
- `PUT    /api/art-requests/:designId/fields`
- `POST   /api/art-requests/:designId/note`
- `POST   /api/art-requests/:designId/reminder-sent`
- `PUT    /api/art-requests/:designId/status`
- `GET    /api/art-requests/ae-approval-digest/scan`
- `POST   /api/art-requests/ae-approval-digest/send`
- `GET    /api/artrequests`
- `POST   /api/artrequests`
- `DELETE /api/artrequests/:id`
- `GET    /api/artrequests/:id`
- `PUT    /api/artrequests/:id`
- `GET    /api/design-notes`
- `POST   /api/design-notes`
- `DELETE /api/design-notes/:id`
- `GET    /api/design-notes/:id`
- `PUT    /api/design-notes/:id`

**assignment-history.js** — 5 endpoints

- `GET    /api/assignment-history`
- `POST   /api/assignment-history`
- `GET    /api/assignment-history/recent`
- `GET    /api/assignment-history/shopworks-todo`
- `GET    /api/assignment-history/stats`

### B

**banner-pricing.js** — 2 endpoints

- `GET    /api/banner-pricing`
- `GET    /api/banner-pricing/quote`

**blog-posts.js** — 4 endpoints

- `GET    /api/blog-posts`
- `POST   /api/blog-posts`
- `GET    /api/blog-posts/:slug`
- `PUT    /api/blog-posts/:slug`

**box-labels-data.js** — 4 endpoints

- `GET    /api/box-labels/lineitems/:orderId`
- `GET    /api/box-labels/order-by-po/:po`
- `GET    /api/box-labels/order/:orderId`
- `POST   /api/box-labels/resolve-parts`

**box-upload.js** — 19 endpoints

- `POST   /api/art-requests/:designId/upload-additional-art`
- `POST   /api/art-requests/:designId/upload-mockup`
- `POST   /api/art-requests/:designId/upload-mockup-url`
- `POST   /api/art-requests/:pkId/auto-recover-mockup`
- `POST   /api/art-requests/auto-recover-mockups-bulk`
- `GET    /api/art-requests/broken-mockups`
- `POST   /api/art-requests/broken-mockups/send-digest`
- `GET    /api/box/art-folders`
- `POST   /api/box/create-mockup-folder`
- `GET    /api/box/download/:fileId`
- `DELETE /api/box/file/:fileId`
- `GET    /api/box/folder-files`
- `GET    /api/box/mockup-folders`
- `GET    /api/box/search`
- `GET    /api/box/shared-image`
- `POST   /api/box/shared-link`
- `GET    /api/box/thumbnail/:fileId`
- `POST   /api/box/upload-to-folder`
- `POST   /api/mockups/:id/upload-file`

**box-webhooks.js** — 2 endpoints

- `POST   /api/box/webhook`
- `GET    /api/box/webhook/health`

### C

**caps-catalog.js** — 1 endpoint

- `GET    /api/caps/catalog`

**cart.js** — 13 endpoints

- `GET    /api/cart-integration.js`
- `GET    /api/cart-item-sizes`
- `POST   /api/cart-item-sizes`
- `DELETE /api/cart-item-sizes/:id`
- `PUT    /api/cart-item-sizes/:id`
- `GET    /api/cart-items`
- `POST   /api/cart-items`
- `DELETE /api/cart-items/:id`
- `PUT    /api/cart-items/:id`
- `GET    /api/cart-sessions`
- `POST   /api/cart-sessions`
- `DELETE /api/cart-sessions/:id`
- `PUT    /api/cart-sessions/:id`

**caspio-schema.js** — 7 endpoints

- `GET    /api/caspio-schema/apps`
- `GET    /api/caspio-schema/full`
- `GET    /api/caspio-schema/tables`
- `GET    /api/caspio-schema/tables/:name/fields`
- `GET    /api/caspio-schema/usage`
- `GET    /api/caspio-schema/views`
- `GET    /api/caspio-schema/webhooks`

**caspio-tasks.js** — 3 endpoints

- `GET    /api/caspio-tasks`
- `GET    /api/caspio-tasks/:name`
- `POST   /api/caspio-tasks/:name/run`

**categories.js** — 1 endpoint

- `GET    /api/categories`

**command-search.js** — 1 endpoint

- `GET    /api/command-search`

**commission-payouts.js** — 7 endpoints

- `GET    /api/commissions/annual-report`
- `POST   /api/commissions/approve`
- `GET    /api/commissions/history`
- `POST   /api/commissions/mark-paid`
- `GET    /api/commissions/quarterly-report`
- `POST   /api/commissions/save`
- `GET    /api/commissions/win-back`

**company-contacts-2026.js** — 1 endpoint

- `GET    /api/company-contacts-2026/search`

**company-contacts.js** — 8 endpoints

- `POST   /api/company-contacts`
- `GET    /api/company-contacts/:id`
- `PUT    /api/company-contacts/:id`
- `GET    /api/company-contacts/by-company`
- `GET    /api/company-contacts/by-customer/:customerId`
- `GET    /api/company-contacts/by-email/:email`
- `GET    /api/company-contacts/search`
- `POST   /api/company-contacts/sync`

**contract-dtg-ai.js** — 1 endpoint

- `POST   /api/contract-dtg-ai/chat`

**contract-dtg-pricing.js** — 1 endpoint

- `GET    /api/contract-dtg/print-costs`

**contract-emblem-ai.js** — 1 endpoint

- `POST   /api/contract-emblem-ai/chat`

**contract-embroidery-ai.js** — 1 endpoint

- `POST   /api/contract-embroidery-ai/chat`

**contract-sticker-ai.js** — 1 endpoint

- `POST   /api/contract-sticker-ai/chat`

**contract-webstore-ai.js** — 1 endpoint

- `POST   /api/contract-webstore-ai/chat`

**creditcard-lookups.js** — 4 endpoints

- `POST   /api/creditcard-atmos/upsert`
- `GET    /api/purchase-orders`
- `GET    /api/supacolor-po-index`
- `GET    /api/vendors`

**custom-decal-pricing.js** — 2 endpoints

- `GET    /api/custom-decal-pricing`
- `GET    /api/custom-decal-pricing/quote`

**customer-history.js** — 2 endpoints

- `GET    /api/customer-history/:idCustomer`
- `GET    /api/customer-history/cache/clear`

**customer-portal-access.js** — 5 endpoints

- `GET    /api/customer-portal-access`
- `POST   /api/customer-portal-access`
- `DELETE /api/customer-portal-access/:pk`
- `PUT    /api/customer-portal-access/:pk`
- `GET    /api/customer-portal-access/by-email/:email`

**customer-profile.js** — 3 endpoints

- `GET    /api/customer-profile/:idCustomer`
- `GET    /api/customer-profile/by-company/:name`
- `GET    /api/customer-profile/cache/clear`

**customer-rewards.js** — 3 endpoints

- `GET    /api/customer-rewards/balance/:idCustomer`
- `POST   /api/customer-rewards/entry`
- `GET    /api/customer-rewards/ledger/:idCustomer`

### D

**daily-sales-by-rep.js** — 7 endpoints

- `GET    /api/caspio/daily-sales-by-rep`
- `POST   /api/caspio/daily-sales-by-rep`
- `POST   /api/caspio/daily-sales-by-rep/archive-date`
- `POST   /api/caspio/daily-sales-by-rep/archive-range`
- `DELETE /api/caspio/daily-sales-by-rep/bulk`
- `POST   /api/caspio/daily-sales-by-rep/import`
- `GET    /api/caspio/daily-sales-by-rep/ytd`

**decorated-cap-prices.js** — 1 endpoint

- `GET    /api/decorated-cap-prices`

**decoration-methods.js** — 1 endpoint

- `GET    /api/decoration-methods`

**designs-by-method.js** — 1 endpoint

- `GET    /api/designs/by-customer/:customerId`

**designs.js** — 5 endpoints

- `GET    /api/designs`
- `POST   /api/designs`
- `DELETE /api/designs/:pk_id`
- `PUT    /api/designs/:pk_id`
- `GET    /api/designs/store/:store_id`

**digitized-designs.js** — 6 endpoints

- `GET    /api/digitized-designs/by-customer`
- `GET    /api/digitized-designs/cache/clear`
- `GET    /api/digitized-designs/fallback`
- `GET    /api/digitized-designs/lookup`
- `GET    /api/digitized-designs/search-all`
- `POST   /api/digitized-designs/sync-rep`

**dtf-push.js** — 4 endpoints

- `GET    /api/dtf-push/health`
- `GET    /api/dtf-push/preview/:quoteId`
- `POST   /api/dtf-push/push-quote`
- `GET    /api/dtf-push/verify/:extOrderId`

**dtg-calibration.js** — 3 endpoints

- `GET    /api/dtg-calibration`
- `POST   /api/dtg-calibration`
- `DELETE /api/dtg-calibration/:pkId`

**dtg-designs.js** — 1 endpoint

- `GET    /api/dtg-designs/by-customer/:customerId`

**dtg-quote-ai.js** — 1 endpoint

- `POST   /api/dtg-quote-ai/chat`

**dtg-top-sellers.js** — 3 endpoints

- `GET    /api/dtg/top-sellers`
- `GET    /api/dtg/top-sellers/categories`
- `GET    /api/dtg/top-sellers/styles`

**dtg.js** — 2 endpoints

- `GET    /api/dtg/product-bundle`
- `POST   /api/dtg/quote-pricing`

### E

**emb-design-routes.js** — 6 endpoints

- `GET    /api/emb-designs`
- `POST   /api/emb-designs`
- `DELETE /api/emb-designs/:id`
- `GET    /api/emb-designs/:id`
- `PUT    /api/emb-designs/:id`
- `GET    /api/emb-designs/by-mockup/:mockupId`

**emb-quote-ai.js** — 2 endpoints

- `POST   /api/emb-quote-ai/chat`
- `GET    /api/emb-quote-ai/emb-margin-cache-status`

**emb-top-sellers.js** — 3 endpoints

- `GET    /api/emb/top-sellers`
- `GET    /api/emb/top-sellers/categories`
- `GET    /api/emb/top-sellers/styles`

**emblem-pricing.js** — 1 endpoint

- `GET    /api/emblem-pricing`

**embroidery-bonus.js** — 6 endpoints

- `GET    /api/embroidery-bonus`
- `POST   /api/embroidery-bonus/archive`
- `GET    /api/embroidery-bonus/call-list`
- `GET    /api/embroidery-bonus/config`
- `GET    /api/embroidery-bonus/dormant`
- `GET    /api/embroidery-bonus/targets`

**embroidery-push.js** — 3 endpoints

- `GET    /api/embroidery-push/health`
- `GET    /api/embroidery-push/preview/:quoteId`
- `POST   /api/embroidery-push/push-quote`

### F

**files-simple.js** — 6 endpoints

- `DELETE /api/files/:externalKey`
- `GET    /api/files/:externalKey`
- `GET    /api/files/:externalKey/info`
- `GET    /api/files/:externalKey/sw.jpg`
- `POST   /api/files/import-from-url`
- `POST   /api/files/upload`

**finished-photos.js** — 6 endpoints

- `GET    /api/finished-photos`
- `POST   /api/finished-photos`
- `DELETE /api/finished-photos/:pkId`
- `PATCH  /api/finished-photos/:pkId`
- `GET    /api/finished-photos/library`
- `GET    /api/finished-photos/lookup`

**form-submissions.js** — 8 endpoints

- `GET    /api/form-submissions`
- `POST   /api/form-submissions`
- `DELETE /api/form-submissions/:submissionId`
- `GET    /api/form-submissions/:submissionId`
- `PUT    /api/form-submissions/:submissionId`
- `POST   /api/form-submissions/:submissionId/push-to-shopworks`
- `PUT    /api/form-submissions/items/:pkId`
- `GET    /api/form-submissions/items/open`

**forms-library.js** — 4 endpoints

- `GET    /api/forms-library`
- `POST   /api/forms-library`
- `DELETE /api/forms-library/:formId`
- `PUT    /api/forms-library/:formId`

### G

**garment-tracker.js** — 12 endpoints

- `GET    /api/garment-tracker`
- `POST   /api/garment-tracker`
- `DELETE /api/garment-tracker/:id`
- `GET    /api/garment-tracker/:id`
- `PUT    /api/garment-tracker/:id`
- `GET    /api/garment-tracker/archive`
- `POST   /api/garment-tracker/archive-from-live`
- `POST   /api/garment-tracker/archive-range`
- `GET    /api/garment-tracker/archive/summary`
- `DELETE /api/garment-tracker/bulk`
- `GET    /api/garment-tracker/config`
- `POST   /api/garment-tracker/import`

**gift-certificates.js** — 4 endpoints

- `GET    /api/gift-certificates`
- `POST   /api/gift-certificates/bulk`
- `GET    /api/gift-certificates/by-order/:orderId`
- `DELETE /api/gift-certificates/clear`

### H

**house-accounts.js** — 11 endpoints

- `GET    /api/house-accounts`
- `POST   /api/house-accounts`
- `DELETE /api/house-accounts/:id`
- `GET    /api/house-accounts/:id`
- `PUT    /api/house-accounts/:id`
- `POST   /api/house-accounts/bulk`
- `GET    /api/house-accounts/full-reconciliation`
- `GET    /api/house-accounts/reconcile`
- `GET    /api/house-accounts/sales`
- `GET    /api/house-accounts/stats`
- `POST   /api/house-accounts/sync-sales`

**house-daily-sales.js** — 4 endpoints

- `GET    /api/house/daily-sales-by-account`
- `POST   /api/house/daily-sales-by-account`
- `POST   /api/house/daily-sales-by-account/bulk`
- `GET    /api/house/daily-sales-by-account/ytd`

### I

**image-uploads.js** — 3 endpoints

- `GET    /api/image-uploads`
- `POST   /api/image-uploads`
- `GET    /api/image-uploads/:imageId`

**industry-lookalikes.js** — 3 endpoints

- `GET    /api/industry-lookalikes`
- `GET    /api/industry-lookalikes/:industry`
- `GET    /api/industry-lookalikes/cache/clear`

**inventory.js** — 2 endpoints

- `GET    /api/inventory`
- `GET    /api/sizes-by-style-color`

### J

**jds-catalog.js** — 3 endpoints

- `GET    /api/jds-catalog`
- `GET    /api/jds-catalog/:sku`
- `GET    /api/jds-catalog/categories`

**jds.js** — 4 endpoints

- `GET    /api/jds/health`
- `GET    /api/jds/inventory/:sku`
- `POST   /api/jds/products`
- `GET    /api/jds/products/:sku`

**jim-mailing-list.js** — 10 endpoints

- `GET    /api/jim-mailing-list`
- `POST   /api/jim-mailing-list`
- `DELETE /api/jim-mailing-list/:id`
- `GET    /api/jim-mailing-list/:id`
- `PUT    /api/jim-mailing-list/:id`
- `POST   /api/jim-mailing-list/extract`
- `POST   /api/jim-mailing-list/mailchimp/engagement`
- `POST   /api/jim-mailing-list/mailchimp/record-sends`
- `GET    /api/jim-mailing-list/mailchimp/status`
- `POST   /api/jim-mailing-list/mailchimp/sync`

**jotform.js** — 4 endpoints

- `GET    /api/jotform/file`
- `GET    /api/jotform/health`
- `POST   /api/jotform/sync`
- `POST   /api/jotform/webhook`

### L

**lead-activity.js** — 11 endpoints

- `GET    /api/lead-activity`
- `POST   /api/lead-activity`
- `POST   /api/lead-categorize/apply`
- `POST   /api/lead-classify/run`
- `GET    /api/lead-classify/scan`
- `POST   /api/lead-conversion/run`
- `GET    /api/lead-conversion/scan`
- `GET    /api/lead-digest/scan`
- `POST   /api/lead-digest/send`
- `POST   /api/lead-outreach`
- `GET    /api/lead-scorecard`

### M

**manageorders-push.js** — 7 endpoints

- `POST   /api/manageorders/auth/test`
- `POST   /api/manageorders/orders/create`
- `GET    /api/manageorders/orders/verify/:extOrderId`
- `GET    /api/manageorders/push/health`
- `GET    /api/manageorders/tracking/pull`
- `POST   /api/manageorders/tracking/push`
- `GET    /api/manageorders/tracking/verify/:extOrderId`

**manageorders.js** — 15 endpoints

- `GET    /api/manageorders/cache-info`
- `GET    /api/manageorders/customers`
- `GET    /api/manageorders/getorderno/:ext_order_id`
- `GET    /api/manageorders/health`
- `POST   /api/manageorders/inventory-cache-clear`
- `GET    /api/manageorders/inventory-cache-stats`
- `GET    /api/manageorders/inventorylevels`
- `GET    /api/manageorders/lineitems/:order_no`
- `GET    /api/manageorders/order/:extOrderId/snapshot`
- `GET    /api/manageorders/orders`
- `GET    /api/manageorders/orders/:order_no`
- `GET    /api/manageorders/payments`
- `GET    /api/manageorders/payments/:order_no`
- `GET    /api/manageorders/tracking`
- `GET    /api/manageorders/tracking/:order_no`

**marketing-shipments.js** — 4 endpoints

- `GET    /api/marketing-shipments`
- `POST   /api/marketing-shipments`
- `PUT    /api/marketing-shipments/:shipmentId`
- `GET    /api/marketing-shipments/items`

**misc.js** — 16 endpoints

- `GET    /api/cart-integration.js`
- `GET    /api/compare-products`
- `POST   /api/create-payment-intent`
- `GET    /api/filter-products`
- `GET    /api/health`
- `GET    /api/locations`
- `GET    /api/products-by-category-subcategory`
- `GET    /api/quick-view`
- `GET    /api/recommendations`
- `GET    /api/related-products`
- `GET    /api/staff-announcements`
- `GET    /api/status`
- `GET    /api/stripe-config`
- `GET    /api/subcategories-by-category`
- `GET    /api/test`
- `GET    /api/test-sanmar-bulk`

**mockup-routes.js** — 20 endpoints

- `POST   /api/mockup-notes`
- `GET    /api/mockup-notes/:mockupId`
- `GET    /api/mockup-notifications`
- `POST   /api/mockup-notifications`
- `POST   /api/mockup-versions`
- `GET    /api/mockup-versions/:mockupId`
- `GET    /api/mockups`
- `POST   /api/mockups`
- `DELETE /api/mockups/:id`
- `GET    /api/mockups/:id`
- `PUT    /api/mockups/:id`
- `POST   /api/mockups/:id/auto-recover-mockup`
- `POST   /api/mockups/:id/restore`
- `PUT    /api/mockups/:id/status`
- `POST   /api/mockups/auto-recover-mockups-bulk`
- `GET    /api/mockups/broken-mockups`
- `POST   /api/mockups/broken-mockups/send-digest`
- `POST   /api/mockups/orphan-digest/send`
- `GET    /api/mockups/orphan-scan`
- `GET    /api/thread-colors`

**monograms.js** — 5 endpoints

- `GET    /api/monograms`
- `POST   /api/monograms`
- `DELETE /api/monograms/:id_monogram`
- `PUT    /api/monograms/:id_monogram`
- `GET    /api/monograms/:orderNumber`

### N

**nika-accounts.js** — 11 endpoints

- `GET    /api/nika-accounts`
- `POST   /api/nika-accounts`
- `DELETE /api/nika-accounts/:id`
- `GET    /api/nika-accounts/:id`
- `PUT    /api/nika-accounts/:id`
- `PUT    /api/nika-accounts/:id/crm`
- `GET    /api/nika-accounts/gap-report`
- `GET    /api/nika-accounts/reconcile`
- `GET    /api/nika-accounts/reverse-gap-report`
- `POST   /api/nika-accounts/sync-ownership`
- `POST   /api/nika-accounts/sync-sales`

**nika-daily-sales.js** — 4 endpoints

- `GET    /api/nika/daily-sales-by-account`
- `POST   /api/nika/daily-sales-by-account`
- `POST   /api/nika/daily-sales-by-account/bulk`
- `GET    /api/nika/daily-sales-by-account/ytd`

**non-sanmar-products.js** — 8 endpoints

- `GET    /api/non-sanmar-products`
- `POST   /api/non-sanmar-products`
- `DELETE /api/non-sanmar-products/:id`
- `GET    /api/non-sanmar-products/:id`
- `PUT    /api/non-sanmar-products/:id`
- `GET    /api/non-sanmar-products/cache/clear`
- `POST   /api/non-sanmar-products/seed`
- `GET    /api/non-sanmar-products/style/:style`

### O

**online-store-commissions.js** — 3 endpoints

- `GET    /api/online-store-commissions/config`
- `GET    /api/online-store-commissions/detail`
- `GET    /api/online-store-commissions/summary`

**order-form-suggestions.js** — 3 endpoints

- `GET    /api/order-form/customer-suggestions`
- `GET    /api/order-form/customer-suggestions/cache/clear`
- `POST   /api/order-form/customer-suggestions/history`

**order-payments.js** — 3 endpoints

- `GET    /api/order-payments/by-quote/:quoteId`
- `POST   /api/order-payments/entry`
- `GET    /api/order-payments/recent`

**orders.js** — 10 endpoints

- `GET    /api/customers`
- `POST   /api/customers`
- `DELETE /api/customers/:id`
- `PUT    /api/customers/:id`
- `GET    /api/order-dashboard`
- `GET    /api/order-odbc`
- `GET    /api/orders`
- `POST   /api/orders`
- `DELETE /api/orders/:id`
- `PUT    /api/orders/:id`

### P

**payroll.js** — 6 endpoints

- `GET    /api/payroll/employees`
- `POST   /api/payroll/import`
- `POST   /api/payroll/parse`
- `GET    /api/payroll/parse/:jobId`
- `GET    /api/payroll/periods`
- `GET    /api/payroll/register`

**pc54-inventory.js** — 4 endpoints

- `GET    /api/manageorders/pc54-inventory`
- `POST   /api/manageorders/pc54-inventory/cache-clear`
- `GET    /api/manageorders/pc54-inventory/cache-stats`
- `GET    /api/manageorders/pc54-inventory/colors`

**policies-ai-assist.js** — 1 endpoint

- `POST   /api/policies-ai-assist`

**policies-ai-search.js** — 1 endpoint

- `POST   /api/policies-ai-search`

**policies.js** — 16 endpoints

- `GET    /api/policies`
- `POST   /api/policies`
- `GET    /api/policies-public`
- `POST   /api/policies-public`
- `DELETE /api/policies-public/:policyId`
- `GET    /api/policies-public/:policyId`
- `PUT    /api/policies-public/:policyId`
- `POST   /api/policies-public/:policyId/move`
- `GET    /api/policies-public/search`
- `GET    /api/policies-public/tree`
- `DELETE /api/policies/:policyId`
- `GET    /api/policies/:policyId`
- `PUT    /api/policies/:policyId`
- `POST   /api/policies/:policyId/move`
- `GET    /api/policies/search`
- `GET    /api/policies/tree`

**policy-comments.js** — 9 endpoints

- `POST   /api/policy-comments-public`
- `DELETE /api/policy-comments-public*`
- `PUT    /api/policy-comments-public*`
- `GET    /api/policy-comments-public/by-policy/:policyId`
- `DELETE /api/policy-comments/:commentId`
- `PUT    /api/policy-comments/:commentId`
- `POST   /api/policy-comments/:commentId/resolve`
- `GET    /api/policy-comments/inbox`
- `GET    /api/policy-comments/inbox/count`

**portal-reorder.js** — 6 endpoints

- `POST   /api/portal-reorder/batch`
- `GET    /api/portal-reorder/recommendations`
- `POST   /api/portal-reorder/request`
- `GET    /api/portal-reorder/requests`
- `DELETE /api/portal-reorder/requests/:pk`
- `PUT    /api/portal-reorder/requests/:pk`

**pricing-matrix.js** — 6 endpoints

- `GET    /api/pricing-matrix`
- `POST   /api/pricing-matrix`
- `DELETE /api/pricing-matrix/:id`
- `GET    /api/pricing-matrix/:id`
- `PUT    /api/pricing-matrix/:id`
- `GET    /api/pricing-matrix/lookup`

**pricing.js** — 18 endpoints

- `GET    /api/al-pricing`
- `GET    /api/base-item-costs`
- `GET    /api/contract-pricing`
- `GET    /api/decg-pricing`
- `GET    /api/dtg-costs`
- `GET    /api/embroidery-costs`
- `POST   /api/embroidery-costs`
- `DELETE /api/embroidery-costs/:id`
- `PUT    /api/embroidery-costs/:id`
- `GET    /api/max-prices-by-style`
- `GET    /api/pricing-bundle`
- `GET    /api/pricing-rules`
- `GET    /api/pricing-tiers`
- `POST   /api/pricing-tiers`
- `DELETE /api/pricing-tiers/:id`
- `PUT    /api/pricing-tiers/:id`
- `GET    /api/screenprint-costs`
- `GET    /api/size-pricing`

**product-upgrades.js** — 4 endpoints

- `GET    /api/product-upgrades`
- `POST   /api/product-upgrades`
- `DELETE /api/product-upgrades/:pk`
- `PUT    /api/product-upgrades/:pk`

**production-schedules.js** — 1 endpoint

- `GET    /api/production-schedules`

**products.js** — 23 endpoints

- `POST   /api/admin/products/add-isnew-field`
- `POST   /api/admin/products/add-istopseller-field`
- `POST   /api/admin/products/clear-isnew`
- `POST   /api/admin/products/clear-istopseller`
- `POST   /api/admin/products/mark-as-new`
- `POST   /api/admin/products/mark-as-topseller`
- `GET    /api/all-brands`
- `GET    /api/all-categories`
- `GET    /api/all-styles`
- `GET    /api/all-subcategories`
- `GET    /api/color-swatches`
- `GET    /api/featured-products`
- `GET    /api/product-cache/clear`
- `GET    /api/product-colors`
- `GET    /api/product-details`
- `GET    /api/products-by-brand`
- `GET    /api/products-by-category`
- `GET    /api/products-by-subcategory`
- `GET    /api/products/new`
- `GET    /api/products/search`
- `GET    /api/products/topsellers`
- `GET    /api/search`
- `GET    /api/stylesearch`

### Q

**quote-change-log.js** — 5 endpoints

- `GET    /api/quote_change_log`
- `POST   /api/quote_change_log`
- `DELETE /api/quote_change_log/:id`
- `GET    /api/quote_change_log/:id`
- `PUT    /api/quote_change_log/:id`

**quote-sequence.js** — 1 endpoint

- `GET    /api/quote-sequence/:prefix`

**quotes.js** — 15 endpoints

- `GET    /api/quote_analytics`
- `POST   /api/quote_analytics`
- `DELETE /api/quote_analytics/:id`
- `GET    /api/quote_analytics/:id`
- `PUT    /api/quote_analytics/:id`
- `GET    /api/quote_items`
- `POST   /api/quote_items`
- `DELETE /api/quote_items/:id`
- `GET    /api/quote_items/:id`
- `PUT    /api/quote_items/:id`
- `GET    /api/quote_sessions`
- `POST   /api/quote_sessions`
- `DELETE /api/quote_sessions/:id`
- `GET    /api/quote_sessions/:id`
- `PUT    /api/quote_sessions/:id`

### R

**rep-audit.js** — 2 endpoints

- `GET    /api/rep-audit`
- `GET    /api/rep-audit/summary`

**rosters.js** — 7 endpoints

- `GET    /api/rosters`
- `POST   /api/rosters`
- `DELETE /api/rosters/:id`
- `GET    /api/rosters/:id`
- `PUT    /api/rosters/:id`
- `POST   /api/rosters/ocr`
- `POST   /api/rosters/parse-excel`

### S

**safety-stripe-top-sellers.js** — 2 endpoints

- `GET    /api/safety-stripes/top-sellers`
- `GET    /api/safety-stripes/top-sellers/styles`

**sales-reps-2026.js** — 8 endpoints

- `GET    /api/sales-reps-2026`
- `POST   /api/sales-reps-2026`
- `DELETE /api/sales-reps-2026/:id`
- `GET    /api/sales-reps-2026/:id`
- `PUT    /api/sales-reps-2026/:id`
- `POST   /api/sales-reps-2026/batch`
- `POST   /api/sales-reps-2026/bulk`
- `GET    /api/sales-reps-2026/stats`

**sanmar-invoices.js** — 10 endpoints

- `POST   /api/sanmar-invoices/backfill`
- `GET    /api/sanmar-invoices/backfill-status`
- `GET    /api/sanmar-invoices/by-date`
- `GET    /api/sanmar-invoices/by-po/:po`
- `GET    /api/sanmar-invoices/imports`
- `GET    /api/sanmar-invoices/incremental`
- `POST   /api/sanmar-invoices/mark-imported`
- `POST   /api/sanmar-invoices/sync`
- `POST   /api/sanmar-invoices/unmark-imported`
- `GET    /api/sanmar-invoices/unpaid`

**sanmar-orders.js** — 22 endpoints

- `POST   /api/sanmar-orders/backfill`
- `GET    /api/sanmar-orders/backfill-status`
- `GET    /api/sanmar-orders/batch-status`
- `GET    /api/sanmar-orders/daily-inbound`
- `GET    /api/sanmar-orders/inbound-today`
- `POST   /api/sanmar-orders/link`
- `GET    /api/sanmar-orders/lookup`
- `POST   /api/sanmar-orders/match-manageorders`
- `GET    /api/sanmar-orders/match-status`
- `GET    /api/sanmar-orders/open`
- `POST   /api/sanmar-orders/po-match`
- `POST   /api/sanmar-orders/po-reconcile`
- `POST   /api/sanmar-orders/quick-match`
- `GET    /api/sanmar-orders/shipments/:po`
- `GET    /api/sanmar-orders/status-summary`
- `GET    /api/sanmar-orders/status/:po`
- `POST   /api/sanmar-orders/sync`
- `POST   /api/sanmar-orders/sync-delivery-dates`
- `GET    /api/sanmar-orders/sync-delivery-dates-status`
- `POST   /api/sanmar-orders/sync-recent-completed`
- `GET    /api/sanmar-orders/sync-recent-completed-status`
- `POST   /api/sanmar-orders/sync-shipments`

**sanmar-product-data.js** — 7 endpoints

- `GET    /api/sanmar/catalog-color-audit/:style`
- `GET    /api/sanmar/closeout-styles`
- `GET    /api/sanmar/discontinued-colors/:style`
- `GET    /api/sanmar/inventory/:style`
- `GET    /api/sanmar/product-colors/:style`
- `GET    /api/sanmar/product-info/:style`
- `GET    /api/sanmar/sellable/:style`

**sanmar-shipments.js** — 3 endpoints

- `GET    /api/sanmar-shipments/by-date`
- `GET    /api/sanmar-shipments/po/:po`
- `GET    /api/sanmar-shipments/so/:so`

**sanmar-shopworks.js** — 5 endpoints

- `GET    /api/sanmar-shopworks/color-mapping`
- `GET    /api/sanmar-shopworks/import-format`
- `GET    /api/sanmar-shopworks/mapping`
- `POST   /api/sanmar-shopworks/quote-to-linesoe`
- `GET    /api/sanmar-shopworks/suffix-mapping`

**scp-push.js** — 4 endpoints

- `GET    /api/scp-push/health`
- `GET    /api/scp-push/preview/:quoteId`
- `POST   /api/scp-push/push-quote`
- `GET    /api/scp-push/verify/:extOrderId`

**service-codes.js** — 10 endpoints

- `GET    /api/service-codes`
- `POST   /api/service-codes`
- `DELETE /api/service-codes/:id`
- `GET    /api/service-codes/:id`
- `PUT    /api/service-codes/:id`
- `GET    /api/service-codes/aliases`
- `GET    /api/service-codes/cache/clear`
- `POST   /api/service-codes/seed`
- `GET    /api/service-codes/tier/:code/:quantity`
- `POST   /api/service-codes/update-fb`

**shipping.js** — 2 endpoints

- `GET    /api/shipping/box-density`
- `POST   /api/shipping/estimate-ups-ground`

**shipstation.js** — 9 endpoints

- `POST   /api/shipstation/create-order`
- `POST   /api/shipstation/dry-run`
- `GET    /api/shipstation/orders`
- `DELETE /api/shipstation/orders/:shipstationOrderId`
- `GET    /api/shipstation/orders/:shipstationOrderId`
- `GET    /api/shipstation/shipments`
- `GET    /api/shipstation/test-auth`
- `GET    /api/shipstation/webhooks`
- `POST   /api/webhooks/shipstation`

**shopworks-odbc-sync.js** — 16 endpoints

- `GET    /api/shopworks-odbc/contacts-health`
- `GET    /api/shopworks-odbc/designs-health`
- `GET    /api/shopworks-odbc/health`
- `POST   /api/shopworks-odbc/health/alert`
- `GET    /api/shopworks-odbc/payables`
- `GET    /api/shopworks-odbc/payables-health`
- `POST   /api/shopworks-odbc/payables-health/alert`
- `GET    /api/shopworks-odbc/po-health`
- `POST   /api/shopworks-odbc/po-health/alert`
- `GET    /api/shopworks-odbc/reps-health`
- `POST   /api/shopworks-odbc/sync-contacts`
- `POST   /api/shopworks-odbc/sync-designs`
- `POST   /api/shopworks-odbc/sync-orders`
- `POST   /api/shopworks-odbc/sync-payables`
- `POST   /api/shopworks-odbc/sync-purchase-orders`
- `POST   /api/shopworks-odbc/sync-sales-reps`

**staff-app-roles.js** — 1 endpoint

- `GET    /api/staff-app-role`

**staff-page-access.js** — 1 endpoint

- `GET    /api/staff-page-access`

**sticker-pricing.js** — 2 endpoints

- `GET    /api/sticker-pricing`
- `GET    /api/sticker-pricing/quote`

**style-performance.js** — 4 endpoints

- `GET    /api/style-performance/:style`
- `GET    /api/style-performance/cache/clear`
- `GET    /api/style-performance/high-margin-alternatives/:style`
- `GET    /api/style-performance/top`

**supacolor-jobs.js** — 20 endpoints

- `GET    /api/supacolor-jobs`
- `POST   /api/supacolor-jobs`
- `DELETE /api/supacolor-jobs/:id`
- `GET    /api/supacolor-jobs/:id`
- `PUT    /api/supacolor-jobs/:id`
- `GET    /api/supacolor-jobs/:id/history`
- `POST   /api/supacolor-jobs/:id/history`
- `POST   /api/supacolor-jobs/:id/history/replace`
- `GET    /api/supacolor-jobs/:id/joblines`
- `POST   /api/supacolor-jobs/:id/joblines`
- `POST   /api/supacolor-jobs/auto-link-sweep`
- `POST   /api/supacolor-jobs/bulk-upsert`
- `GET    /api/supacolor-jobs/by-number/:jobNumber`
- `GET    /api/supacolor-jobs/health`
- `POST   /api/supacolor-jobs/health/alert`
- `GET    /api/supacolor-jobs/proxy-image`
- `GET    /api/supacolor-jobs/stats`
- `POST   /api/supacolor-jobs/sync/:jobNumber`
- `POST   /api/supacolor-jobs/sync/all`
- `POST   /api/supacolor-jobs/upsert`

### T

**taneisha-accounts.js** — 11 endpoints

- `GET    /api/taneisha-accounts`
- `POST   /api/taneisha-accounts`
- `DELETE /api/taneisha-accounts/:id`
- `GET    /api/taneisha-accounts/:id`
- `PUT    /api/taneisha-accounts/:id`
- `PUT    /api/taneisha-accounts/:id/crm`
- `GET    /api/taneisha-accounts/gap-report`
- `GET    /api/taneisha-accounts/reconcile`
- `GET    /api/taneisha-accounts/reverse-gap-report`
- `POST   /api/taneisha-accounts/sync-ownership`
- `POST   /api/taneisha-accounts/sync-sales`

**taneisha-daily-sales.js** — 4 endpoints

- `GET    /api/taneisha/daily-sales-by-account`
- `POST   /api/taneisha/daily-sales-by-account`
- `POST   /api/taneisha/daily-sales-by-account/bulk`
- `GET    /api/taneisha/daily-sales-by-account/ytd`

**tax-rate.js** — 7 endpoints

- `GET    /api/tax-rates`
- `POST   /api/tax-rates`
- `GET    /api/tax-rates/:accountNumber`
- `DELETE /api/tax-rates/:id`
- `PUT    /api/tax-rates/:id`
- `GET    /api/tax-rates/cache/clear`
- `POST   /api/tax-rates/lookup`

**thread-colors.js** — 1 endpoint

- `GET    /api/thread-colors`

**thumbnails.js** — 13 endpoints

- `PUT    /api/thumbnails/:thumbnailId/external-key`
- `GET    /api/thumbnails/all-ids`
- `POST   /api/thumbnails/archive-to-box`
- `POST   /api/thumbnails/backfill-fileurls`
- `GET    /api/thumbnails/by-design/:designId`
- `GET    /api/thumbnails/by-designs`
- `DELETE /api/thumbnails/delete-by-year/:year`
- `POST   /api/thumbnails/metadata-sync`
- `POST   /api/thumbnails/reconcile-files`
- `GET    /api/thumbnails/stats-by-year`
- `GET    /api/thumbnails/sync-status`
- `POST   /api/thumbnails/upload-with-stub`
- `GET    /api/thumbnails/uploaded-ids`

**transfer-orders.js** — 13 endpoints

- `POST   /api/transfer-order-notes`
- `GET    /api/transfer-orders`
- `POST   /api/transfer-orders`
- `DELETE /api/transfer-orders/:id`
- `GET    /api/transfer-orders/:id`
- `PUT    /api/transfer-orders/:id`
- `PUT    /api/transfer-orders/:id/files`
- `PUT    /api/transfer-orders/:id/lines`
- `GET    /api/transfer-orders/:id/notes`
- `PUT    /api/transfer-orders/:id/rush`
- `PUT    /api/transfer-orders/:id/status`
- `POST   /api/transfer-orders/analyze-link`
- `GET    /api/transfer-orders/stats`

**transfers.js** — 6 endpoints

- `GET    /api/transfers`
- `GET    /api/transfers/lookup`
- `GET    /api/transfers/matrix`
- `GET    /api/transfers/price-types`
- `GET    /api/transfers/quantity-ranges`
- `GET    /api/transfers/sizes`

### U

**ups-tracking.js** — 3 endpoints

- `GET    /api/ups-tracking/:trackingNumber`
- `GET    /api/ups-tracking/health`
- `GET    /api/ups-tracking/quantum-test`

### V

**vendor-portal-access.js** — 6 endpoints

- `GET    /api/vendor-portal-access`
- `POST   /api/vendor-portal-access`
- `DELETE /api/vendor-portal-access/:pk`
- `PUT    /api/vendor-portal-access/:pk`
- `GET    /api/vendor-portal-access/by-email/:email`
- `POST   /api/vendor-portal-access/touch-login`

**vision.js** — 5 endpoints

- `POST   /api/vision/extract-mockup-info`
- `POST   /api/vision/extract-shopworks`
- `POST   /api/vision/extract-supacolor`
- `POST   /api/vision/extract-supacolor-job-detail`
- `POST   /api/vision/extract-supacolor-jobs-list`

