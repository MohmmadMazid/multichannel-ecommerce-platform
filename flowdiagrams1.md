# MultiChannel Commerce — System Architecture & Flow Diagrams

This document contains comprehensive architecture and workflow diagrams for the MultiChannel Commerce application. All diagrams are written in standard [Mermaid](https://mermaid.js.org/) syntax and can be previewed directly on GitHub or pasted into [mermaid.live](https://mermaid.live).

---

## Table of Contents
1. [High-Level System Architecture](#1-high-level-system-architecture)
2. [Product Creation & Marketplace Publishing Flow](#2-product-creation--marketplace-publishing-flow)
3. [Shopify Real-Time Webhook & Cross-Channel Inventory Sync](#3-shopify-real-time-webhook--cross-channel-inventory-sync)
4. [Catalog Import Flow (Shopify & eBay to Master Catalog)](#4-catalog-import-flow-shopify--ebay-to-master-catalog)
5. [Resilient Sync & Redis Queue Fallback Architecture](#5-resilient-sync--redis-queue-fallback-architecture)
6. [Product Mapping Lifecycle & Soft-Delete Re-Activation](#6-product-mapping-lifecycle--soft-delete-re-activation)

---

## 1. Complete System Architecture & Flow Diagram

```mermaid
flowchart TB
    %% ===================================================
    %% FRONTEND LAYER
    %% ===================================================
    subgraph Frontend["Frontend Layer (Next.js 15 App Router / Tailwind CSS)"]
        direction TB
        subgraph UI_Pages["User Interface Views & Pages"]
            UI_Prod["Products Catalog & Form Modal"]
            UI_Pub["Product Publish Modal (Multi-Channel)"]
            UI_Map["Product Mappings Table & Channel Overrides"]
            UI_Int["Integrations Manager (Shopify / eBay / Custom)"]
            UI_Sync["Sync Activity & Audit Logs Table"]
            UI_CSV["CSV Bulk Import Dialog"]
            UI_Prof["Profitability & Fee Analytics"]
        end

        subgraph Client_Core["Client State & Network Infrastructure"]
            TanStack["TanStack Query Cache & Auto-Refetch"]
            AuthStore["Auth Context & JWT Token Store"]
            API_Client["Unified API Client (Axios / Fetch Services)"]
        end

        UI_Prod --> TanStack
        UI_Pub --> TanStack
        UI_Map --> TanStack
        UI_Int --> TanStack
        UI_Sync --> TanStack
        UI_CSV --> TanStack
        UI_Prof --> TanStack

        TanStack --> API_Client
        AuthStore --> API_Client
    end

    %% ===================================================
    %% GATEWAY & MIDDLEWARE LAYER
    %% ===================================================
    subgraph Gateway["API Security & Middleware Gateway (Express 5)"]
        direction TB
        CORS["CORS & Helmet & Rate Limiter"]
        AuthMid["JWT Authentication Middleware (req.user)"]
        ZodMid["Zod Request Validation Middleware (Schemas)"]
        WebVerify["Shopify Webhook HMAC-SHA256 Verifier"]
    end

    API_Client -- "REST HTTPS Requests (Bearer JWT)" --> CORS
    CORS --> AuthMid
    AuthMid --> ZodMid

    %% ===================================================
    %% BACKEND SERVICES & APPLICATION LOGIC
    %% ===================================================
    subgraph Backend["Core Application Services (Node.js / Express / TypeScript)"]
        direction TB

        subgraph Svc_Prod["Product Management Service"]
            Prod_CRUD["Product CRUD & Catalog Queries"]
            Prod_SKU["Scoped SKU Uniqueness Check (Tenant + Active)"]
            Prod_Del["Cascade Soft-Delete Handler"]
        end

        subgraph Svc_Map["Product Mapping Service"]
            Map_CRUD["Mapping Management (Channel Price & Stock)"]
            Map_Reactivate["Soft-Delete Re-Activation Engine"]
            Map_FanOut["Cross-Channel Inventory Broadcast"]
        end

        subgraph Svc_OAuth["Integration & Channel Auth Service"]
            OAuth_Shopify["Shopify OAuth 2.0 (Scopes, Offline Access Tokens)"]
            OAuth_Ebay["eBay OAuth 2.0 (Code Grant, Refresh Token Loop)"]
            Ebay_Policies["eBay Account Policies (Fulfillment, Payment, Return)"]
            Channel_Health["Channel Health & Connection Tester"]
        end

        subgraph Svc_Import["Import & Catalog Sync Services"]
            CSV_Parser["CSV Stream Parser & Bulk Upsert"]
            Catalog_Import["Marketplace Catalog Importer (Shopify / eBay)"]
        end

        subgraph Svc_Fees["Platform Fees & Profitability Engine"]
            Fee_Calc["Platform Fee Calculator (Shopify, eBay, Custom)"]
            Profit_Calc["Margin, Shipping & Net Profit Calculator"]
        end

        subgraph Svc_Sync["Sync Engine & Connector Factory"]
            Connector_Factory["Marketplace Connector Factory"]
            Idempotency["Idempotency Lock & Stale Job Recovery (>60s)"]
            Action_Resolver["Action Auto-Resolver (UPDATE to CREATE if unmapped)"]
            Direct_Fallback["Direct Sync Fallback Engine (Zero-Downtime)"]
            
            Shopify_Conn["Shopify GraphQL Connector (2026 Admin API)"]
            Ebay_Conn["eBay REST & Inventory API Connector"]
            Custom_Conn["Custom Website REST Connector"]
        end

        subgraph Svc_Webhooks["Inbound Webhook Controller"]
            Hook_Inv["Shopify inventory_levels/update Handler"]
            Hook_Prod["Shopify products/create and products/update Handler"]
            Hook_Dedup["In-Flight Race Prevention & De-duplication"]
        end
    end

    %% Gateway Routing
    ZodMid -- "/api/products" --> Svc_Prod
    ZodMid -- "/api/product-mappings" --> Svc_Map
    ZodMid -- "/api/integrations" --> Svc_OAuth
    ZodMid -- "/api/sync" --> Svc_Sync
    ZodMid -- "/api/csv-import & catalog-import" --> Svc_Import

    %% Inter-service logic
    Prod_CRUD -- "Trigger Publishing" --> Map_CRUD
    Map_CRUD -- "Dispatch Sync Job" --> Svc_Sync
    Map_FanOut -- "Broadcast to other channels" --> Svc_Sync
    Catalog_Import -- "Upsert Master & Mappings" --> Svc_Prod
    CSV_Parser -- "Bulk Upsert" --> Svc_Prod

    Connector_Factory --> Shopify_Conn
    Connector_Factory --> Ebay_Conn
    Connector_Factory --> Custom_Conn

    %% ===================================================
    %% JOB QUEUE & WORKER INFRASTRUCTURE
    %% ===================================================
    subgraph Queue_System["Async Job Queue & Execution Layer"]
        direction TB
        BullQueue[("BullMQ Queue: product-sync-queue (Redis)")]
        WorkerProc["Background Worker Daemon (src/worker.ts)"]
        DirectExec["Direct In-Process Execution (Fallback Engine)"]
    end

    Svc_Sync -- "1. Try Enqueue Job" --> BullQueue
    BullQueue -- "Job Dispatch" --> WorkerProc
    WorkerProc -- "Execute Sync Job" --> Connector_Factory

    Svc_Sync -- "2. If Redis Offline / Queue Error" --> DirectExec
    DirectExec -- "Direct Execution Fallback" --> Connector_Factory

    %% ===================================================
    %% DATABASE & PERSISTENCE LAYER
    %% ===================================================
    subgraph Database["Database Layer (MongoDB Atlas)"]
        direction TB
        DB_Users[("users: Merchant Accounts & Tenant IDs")]
        DB_Prods[("products: Master Catalog (SKU, Title, Base Stock, Price)")]
        DB_Maps[("productmappings: Channel Links, Overrides, External IDs")]
        DB_Ints[("integrations: Store URLs, OAuth Tokens, Refresh Keys")]
        DB_Logs[("synclogs: Full Audit Trail & Error Logs")]
        DB_Configs[("platformconfigs: Platform Fee Rules & Rates")]
    end

    Svc_Prod <--> DB_Prods
    Svc_Map <--> DB_Maps
    Svc_OAuth <--> DB_Ints
    Svc_Sync <--> DB_Logs
    Svc_Fees <--> DB_Configs
    AuthMid <--> DB_Users

    %% ===================================================
    %% EXTERNAL MARKETPLACES & SALES CHANNELS
    %% ===================================================
    subgraph Marketplaces["External Marketplaces & Sales Channels"]
        direction TB

        subgraph Ext_Shopify["Shopify Store (Admin API)"]
            Shop_ProdCreate["GraphQL: productCreate (descriptionHtml, media)"]
            Shop_VarUpdate["GraphQL: productVariantsBulkUpdate (price)"]
            Shop_InvUpdate["GraphQL: inventoryItemUpdate (sku, tracked)"]
            Shop_InvSet["GraphQL: inventorySetQuantities (quantity, location)"]
            Shop_WebhookPub["Webhooks Emitter (inventory & product events)"]
        end

        subgraph Ext_Ebay["eBay Marketplace (Developer API)"]
            Ebay_OAuthApi["Identity API: OAuth2 Token Exchange & Refresh"]
            Ebay_InvApi["Inventory API: createOrReplaceInventoryItem"]
            Ebay_OfferApi["Offer API: createOffer & publishOffer"]
            Ebay_Taxonomy["Taxonomy API: Category Tree & Aspect Discovery"]
        end

        subgraph Ext_Custom["Custom Website Channel"]
            Custom_Api["Custom Webhook Endpoint / REST Storefront API"]
        end
    end

    %% Outbound Channel Connections
    Shopify_Conn -- "mutation productCreate" --> Shop_ProdCreate
    Shopify_Conn -- "mutation productVariantsBulkUpdate" --> Shop_VarUpdate
    Shopify_Conn -- "mutation inventoryItemUpdate" --> Shop_InvUpdate
    Shopify_Conn -- "mutation inventorySetQuantities" --> Shop_InvSet

    OAuth_Shopify -- "OAuth Token Exchange" --> Ext_Shopify
    OAuth_Ebay -- "OAuth Token Exchange" --> Ebay_OAuthApi
    Ebay_Conn -- "Sync Stock & Aspects" --> Ebay_InvApi
    Ebay_Conn -- "Publish Listing Offer" --> Ebay_OfferApi
    Ebay_Conn -- "Aspect Discovery" --> Ebay_Taxonomy

    Custom_Conn -- "Direct REST Sync" --> Custom_Api

    %% Inbound Webhook Connections
    Shop_WebhookPub -- "POST /api/integrations/shopify/webhooks" --> WebVerify
    WebVerify --> Hook_Inv
    WebVerify --> Hook_Prod
    Hook_Inv --> Map_FanOut
    Hook_Prod --> Hook_Dedup
    Hook_Dedup --> Svc_Prod
```

---

## 2. Product Creation & Marketplace Publishing Flow

```mermaid
sequenceDiagram
    autonumber
    actor Merchant as Merchant / User
    participant UI as Frontend (Dashboard)
    participant API as Backend (Product Controller)
    participant DB as MongoDB
    participant Sync as Sync Engine
    participant Shopify as Shopify GraphQL API
    participant Ebay as eBay Inventory API

    Merchant->>UI: Fill product details & click "Create / Publish"
    UI->>API: POST /api/products (with integrationIds)
    API->>DB: Check SKU uniqueness { userId, sku, isDeleted: false }
    API->>DB: Insert Master Product document

    loop For each selected sales channel
        API->>DB: Find or create ProductMapping (seeded price/stock)
        API->>Sync: enqueueSyncJob(mappingId, CREATE)
        
        alt Redis Available
            Sync->>Sync: Push job to BullMQ queue
            Sync-->>API: Status: PENDING
        else Redis Unavailable / Direct Fallback
            Sync->>Sync: executeDirectMarketplaceSync()
            
            alt Target: Shopify
                Sync->>Shopify: mutation productCreate(input, media)
                Sync->>Shopify: mutation productVariantsBulkUpdate(price)
                Sync->>Shopify: mutation inventoryItemUpdate(sku)
                Sync->>Shopify: mutation inventorySetQuantities(stock)
                Shopify-->>Sync: Return Product ID & Variant ID
            else Target: eBay
                Sync->>Ebay: createOrReplaceInventoryItem(sku, stock)
                Sync->>Ebay: createOffer(price, category, policies)
                Sync->>Ebay: publishOffer(offerId)
                Ebay-->>Sync: Return Listing ID
            end
            
            Sync->>DB: Update ProductMapping (externalProductId, SYNCED)
            Sync->>DB: Create SyncLog record (COMPLETED)
        end
    end

    API-->>UI: 201 Created / 202 Accepted
    UI-->>Merchant: Toast: "Product published successfully"
```

---

## 3. Shopify Real-Time Webhook & Cross-Channel Inventory Sync

This flow prevents **multi-channel overselling**. When an order is placed on Shopify, the stock level decreases, triggering an automatic fan-out sync to eBay and other channels.

```mermaid
flowchart TD
    Start(["Customer purchases item on Shopify"]) --> Webhook["Shopify triggers webhook: inventory_levels/update"]
    Webhook --> Verify{"HMAC SHA-256 Signature Valid?"}

    Verify -- "No" --> Reject["401 Unauthorized (Reject payload)"]
    Verify -- "Yes" --> FindMap["Lookup ProductMapping by externalInventoryItemId"]

    FindMap --> Found{"Mapping Found?"}
    Found -- "No" --> ExitNone["Ignore (Unmapped store item)"]
    Found -- "Yes" --> UpdateMaster["Update Master Product quantity in MongoDB"]

    UpdateMaster --> FindOthers["Query all other active ProductMappings for this Product"]
    FindOthers --> HasOthers{"Other channels exist?"}

    HasOthers -- "No" --> Done["Stock updated in Catalog"]
    HasOthers -- "Yes" --> FanOut["Loop through other channel mappings (e.g. eBay)"]

    FanOut --> PushSync["enqueueSyncJob(otherMappingId, UPDATE)"]
    PushSync --> UpdateEbay["eBay Inventory API: Update quantity to match"]
    UpdateEbay --> Parity(["100% Inventory Parity Achieved — No Overselling"])
```

---

## 4. Catalog Import Flow (Shopify & eBay to Master Catalog)

```mermaid
sequenceDiagram
    autonumber
    actor Merchant as Merchant
    participant UI as Integrations Page
    participant API as Catalog Import Controller
    participant Service as Catalog Import Service
    participant Channel as Marketplace API (Shopify / eBay)
    participant DB as MongoDB

    Merchant->>UI: Click "Import Products" for connected channel
    UI->>API: POST /api/integrations/:id/import-catalog
    API->>Service: importCatalog(userId, integrationId)
    Service->>DB: Verify active Integration credentials
    
    Service->>Channel: Fetch paginated products / listings
    Channel-->>Service: Return external catalog items

    loop For each remote item
        Service->>DB: Find existing Master Product by SKU { userId, sku, isDeleted: false }
        
        alt Master Product Exists
            Service->>DB: Update Master Product details if needed
        else New Product
            Service->>DB: Insert new Master Product into Catalog
        end

        Service->>DB: Upsert ProductMapping with external IDs & SYNCED status
    end

    Service-->>API: Summary { totalFound, imported, updated, failed }
    API-->>UI: 200 OK with import summary
    UI-->>Merchant: Display Import Result Summary Modal
```

---

## 5. Resilient Sync & Redis Queue Fallback Architecture

```mermaid
flowchart TD
    Trigger["Sync Triggered (Create / Update / Delete)"] --> CheckLock{"Active job in progress for this mapping?"}
    
    CheckLock -- "Yes and < 60s old" --> RejectLock["409 Conflict: Sync job already in progress"]
    CheckLock -- "Yes but > 60s old (Stale)" --> ClearLock["Auto-recover: Mark stale job FAILED"]
    CheckLock -- "No active job" --> CreateLog["Create SyncLog record (PENDING)"]
    ClearLock --> CreateLog

    CreateLog --> ActionCheck{"Is action UPDATE but externalProductId is empty?"}
    ActionCheck -- "Yes" --> SwitchAction["Auto-resolve action to CREATE"]
    ActionCheck -- "No" --> KeepAction["Proceed with requested action"]

    SwitchAction --> QueueTry{"Is Redis Queue connected?"}
    KeepAction --> QueueTry

    QueueTry -- "Yes" --> Enqueue["Push job to BullMQ queue"]
    Enqueue --> WorkerProc["Background Worker processes job asynchronously"]

    QueueTry -- "No / Redis throws error" --> DirectFallback["Direct Execution Fallback: executeDirectMarketplaceSync()"]
    WorkerProc --> MarketplaceCall["Execute Marketplace Connector API"]
    DirectFallback --> MarketplaceCall

    MarketplaceCall --> CallSuccess{"API Call Successful?"}
    CallSuccess -- "Yes" --> SaveMapping["Update ProductMapping: SYNCED, IDs saved"]
    CallSuccess -- "No" --> SaveFailure["Update ProductMapping: FAILED, save exact error message"]

    SaveMapping --> WebhookRace{"Race check: Did webhook create duplicate mapping?"}
    WebhookRace -- "E11000 collision" --> Dedup["Clean up duplicate webhook record & persist master mapping"]
    WebhookRace -- "Clean" --> MarkComplete["Mark SyncLog: COMPLETED"]
    Dedup --> MarkComplete

    SaveFailure --> MarkFailed["Mark SyncLog: FAILED"]
```

---

## 6. Product Mapping Lifecycle & Soft-Delete Re-Activation

```mermaid
stateDiagram-v2
    [*] --> Unmapped: Product created in Master Catalog
    
    Unmapped --> Pending: "Publish to Channel" selected
    Pending --> Synced: Marketplace creation succeeds (External IDs assigned)
    Pending --> Failed: Marketplace rejected listing (Invalid Category / Token / Schema)
    
    Failed --> Pending: Retry Sync / Fix Channel Overrides
    
    Synced --> Synced: Price / Quantity / Title update pushed
    
    Synced --> Unmapped: Merchant removes channel mapping
    Failed --> Unmapped: Merchant deletes failed mapping
    
    Unmapped --> SoftDeleted: Mapping soft-deleted (isDeleted: true)
    
    SoftDeleted --> Synced: Merchant re-maps item (Clean re-activation without E11000 duplicate key error)
    
    Synced --> [*]: Master product permanently deleted
```
