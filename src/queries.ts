export const MONEY_FRAGMENT = /* GraphQL */ `
  fragment MoneyFields on MoneyV2 {
    amount
    currencyCode
  }
`;

export const IMAGE_FRAGMENT = /* GraphQL */ `
  fragment ImageFields on Image {
    url
    altText
    width
    height
  }
`;

export const VARIANT_FRAGMENT = /* GraphQL */ `
  ${MONEY_FRAGMENT}
  ${IMAGE_FRAGMENT}
  fragment VariantFields on ProductVariant {
    id
    title
    sku
    availableForSale
    quantityAvailable
    price { ...MoneyFields }
    compareAtPrice { ...MoneyFields }
    selectedOptions { name value }
    image { ...ImageFields }
  }
`;

/** Every product field except media, which is where the card and gallery selections diverge. */
const PRODUCT_CORE_FRAGMENT = /* GraphQL */ `
  ${VARIANT_FRAGMENT}
  fragment ProductCoreFields on Product {
    id
    handle
    title
    description
    descriptionHtml
    vendor
    productType
    tags
    totalInventory
    availableForSale
    priceRange {
      minVariantPrice { ...MoneyFields }
      maxVariantPrice { ...MoneyFields }
    }
    compareAtPriceRange {
      minVariantPrice { ...MoneyFields }
      maxVariantPrice { ...MoneyFields }
    }
    options { id name values }
    variants(first: 100) { nodes { ...VariantFields } }
    images(first: 20) { nodes { ...ImageFields } }
    featuredImage { ...ImageFields }
    onlineStoreUrl
    updatedAt
    createdAt
  }
`;

/**
 * For the card-only paths — collection products, search, `byIds`, recommendations. Media is
 * reduced to content types, which is all a grid asks of it (the play badge), rather than every
 * product in the grid carrying video sources and preview images. `ProductFields` has both.
 */
export const PRODUCT_CARD_FRAGMENT = /* GraphQL */ `
  ${PRODUCT_CORE_FRAGMENT}
  fragment ProductCardFields on Product {
    ...ProductCoreFields
    media(first: 250) { nodes { mediaContentType } }
  }
`;

export const PRODUCT_FRAGMENT = /* GraphQL */ `
  ${PRODUCT_CORE_FRAGMENT}
  fragment ProductFields on Product {
    ...ProductCoreFields
    # Videos are appended after images, so a small window misses them entirely.
    media(first: 250) {
      nodes {
        mediaContentType
        alt
        previewImage { url }
        ... on MediaImage { id image { url altText } }
        # mimeType tells the usable mp4s from the HLS/DASH manifests Shopify also returns.
        ... on Video { id sources { url mimeType width height } }
        ... on ExternalVideo { id embeddedUrl host }
      }
    }
  }
`;

export const COLLECTION_FRAGMENT = /* GraphQL */ `
  ${IMAGE_FRAGMENT}
  fragment CollectionFields on Collection {
    id
    handle
    title
    description
    descriptionHtml
    image { ...ImageFields }
  }
`;

export const CART_FRAGMENT = /* GraphQL */ `
  ${VARIANT_FRAGMENT}
  ${MONEY_FRAGMENT}
  fragment CartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    note
    buyerIdentity { countryCode email phone }
    cost {
      subtotalAmount { ...MoneyFields }
      totalAmount { ...MoneyFields }
      totalTaxAmount { ...MoneyFields }
      checkoutChargeAmount { ...MoneyFields }
    }
    discountCodes { code applicable }
    appliedGiftCards {
      id
      lastCharacters
      presentmentAmountUsed { ...MoneyFields }
      balance { ...MoneyFields }
      amountUsed { ...MoneyFields }
    }
    createdAt
    updatedAt
    lines(first: 250) {
      nodes {
        id
        quantity
        attributes { key value }
        cost {
          totalAmount { ...MoneyFields }
          amountPerQuantity { ...MoneyFields }
          compareAtAmountPerQuantity { ...MoneyFields }
        }
        merchandise {
          ... on ProductVariant {
            ...VariantFields
            product { id title handle }
          }
        }
      }
    }
  }
`;

export const ADDRESS_FRAGMENT = /* GraphQL */ `
  fragment AddressFields on MailingAddress {
    id
    firstName
    lastName
    address1
    address2
    city
    province
    country
    zip
    phone
  }
`;

export const CUSTOMER_FRAGMENT = /* GraphQL */ `
  ${ADDRESS_FRAGMENT}
  fragment CustomerFields on Customer {
    id
    email
    firstName
    lastName
    phone
    acceptsMarketing
    defaultAddress { ...AddressFields }
  }
`;

// Operations

export const PRODUCTS_LIST_QUERY = /* GraphQL */ `
  ${PRODUCT_FRAGMENT}
  query Products($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
    products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      nodes { ...ProductFields }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

export const PRODUCT_BY_HANDLE_QUERY = /* GraphQL */ `
  ${PRODUCT_FRAGMENT}
  query ProductByHandle($handle: String!) {
    product(handle: $handle) { ...ProductFields }
  }
`;

export const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  ${PRODUCT_FRAGMENT}
  query ProductById($id: ID!) {
    product(id: $id) { ...ProductFields }
  }
`;

export const PRODUCT_RECOMMENDATIONS_QUERY = /* GraphQL */ `
  ${PRODUCT_CARD_FRAGMENT}
  query Recommended($productId: ID!) {
    productRecommendations(productId: $productId) { ...ProductCardFields }
  }
`;

export const COLLECTIONS_LIST_QUERY = /* GraphQL */ `
  ${COLLECTION_FRAGMENT}
  query Collections($first: Int!, $after: String, $query: String, $sortKey: CollectionSortKeys, $reverse: Boolean) {
    collections(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      nodes { ...CollectionFields }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

export const COLLECTION_BY_HANDLE_QUERY = /* GraphQL */ `
  ${COLLECTION_FRAGMENT}
  query CollectionByHandle($handle: String!) {
    collection(handle: $handle) { ...CollectionFields }
  }
`;

export const COLLECTION_PRODUCTS_QUERY = /* GraphQL */ `
  ${PRODUCT_CARD_FRAGMENT}
  query CollectionProducts($handle: String!, $first: Int!, $after: String, $sortKey: ProductCollectionSortKeys, $reverse: Boolean, $filters: [ProductFilter!]) {
    collection(handle: $handle) {
      handle
      title
      products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
        nodes { ...ProductCardFields }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        filters {
          id
          label
          type
          values { id label count input }
        }
      }
    }
  }
`;

export const SEARCH_PRODUCTS_QUERY = /* GraphQL */ `
  ${PRODUCT_CARD_FRAGMENT}
  query SearchProducts(
    $query: String!
    $first: Int!
    $after: String
    $productFilters: [ProductFilter!]
    # SearchSortKeys, NOT ProductSortKeys — only RELEVANCE and PRICE exist here.
    $sortKey: SearchSortKeys
    $reverse: Boolean
  ) {
    search(
      query: $query
      first: $first
      after: $after
      types: [PRODUCT]
      productFilters: $productFilters
      sortKey: $sortKey
      reverse: $reverse
    ) {
      totalCount
      nodes {
        ... on Product { ...ProductCardFields }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      productFilters {
        id
        label
        type
        values { id label count input }
      }
    }
  }
`;

export const CART_CREATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartCreate($input: CartInput) {
    cartCreate(input: $input) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_GET_QUERY = /* GraphQL */ `
  ${CART_FRAGMENT}
  query CartGet($id: ID!) {
    cart(id: $id) { ...CartFields }
  }
`;

export const CART_LINES_ADD_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_LINES_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_LINES_REMOVE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_DISCOUNT_CODES_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]) {
    cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

/**
 * The shopper's order note. It rides the cart to the order, where the merchant reads it beside the
 * line items — so it is content, not a cart attribute, and Shopify gives it its own mutation.
 *
 * **`note` is `String!`, not `String`.** Declaring the variable nullable is rejected outright with
 * `Nullability mismatch on variable $note and argument note` — the whole mutation fails, so this is
 * not a case that only shows up when clearing. Clearing is the empty string, which is also what a
 * cart with no note reads back as.
 */
export const CART_NOTE_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartNoteUpdate($cartId: ID!, $note: String!) {
    cartNoteUpdate(cartId: $cartId, note: $note) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_BUYER_IDENTITY_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
    cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

// Gift cards are a payment tender in Shopify (not a discount), so they stack
// past `combinesWith` rules. Apply requires `buyerIdentity.countryCode` on
// the cart — otherwise Shopify returns INVALID_PAYMENT. See tile-credit
// integration guide §5 for the full flow.
export const CART_GIFT_CARD_CODES_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartGiftCardCodesUpdate($cartId: ID!, $giftCardCodes: [String!]!) {
    cartGiftCardCodesUpdate(cartId: $cartId, giftCardCodes: $giftCardCodes) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_GIFT_CARD_CODES_REMOVE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartGiftCardCodesRemove($cartId: ID!, $appliedGiftCardIds: [ID!]!) {
    cartGiftCardCodesRemove(cartId: $cartId, appliedGiftCardIds: $appliedGiftCardIds) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

/** Shop's IP-localized country (e.g. `"US"`). We use this as the fallback
 *  countryCode when applying a gift card so the cart has a payment tender. */
export const SHOP_LOCALIZATION_QUERY = /* GraphQL */ `
  query ShopLocalization {
    localization {
      country { isoCode name }
    }
  }
`;

export const CUSTOMER_CREATE_MUTATION = /* GraphQL */ `
  ${CUSTOMER_FRAGMENT}
  mutation CustomerCreate($input: CustomerCreateInput!) {
    customerCreate(input: $input) {
      customer { ...CustomerFields }
      customerUserErrors { field message code }
    }
  }
`;

export const CUSTOMER_ACCESS_TOKEN_CREATE_MUTATION = /* GraphQL */ `
  mutation CustomerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
    customerAccessTokenCreate(input: $input) {
      customerAccessToken { accessToken expiresAt }
      customerUserErrors { field message code }
    }
  }
`;

export const CUSTOMER_ACCESS_TOKEN_DELETE_MUTATION = /* GraphQL */ `
  mutation CustomerAccessTokenDelete($customerAccessToken: String!) {
    customerAccessTokenDelete(customerAccessToken: $customerAccessToken) {
      deletedAccessToken
      userErrors { field message }
    }
  }
`;

export const CUSTOMER_QUERY = /* GraphQL */ `
  ${CUSTOMER_FRAGMENT}
  query Customer($accessToken: String!) {
    customer(customerAccessToken: $accessToken) { ...CustomerFields }
  }
`;

export const CUSTOMER_RECOVER_MUTATION = /* GraphQL */ `
  mutation CustomerRecover($email: String!) {
    customerRecover(email: $email) {
      customerUserErrors { field message code }
    }
  }
`;

export const CUSTOMER_UPDATE_MUTATION = /* GraphQL */ `
  ${CUSTOMER_FRAGMENT}
  mutation CustomerUpdate($accessToken: String!, $customer: CustomerUpdateInput!) {
    customerUpdate(customerAccessToken: $accessToken, customer: $customer) {
      customer { ...CustomerFields }
      customerUserErrors { field message code }
    }
  }
`;

// Orders

export const ORDER_FRAGMENT = /* GraphQL */ `
  ${MONEY_FRAGMENT}
  ${IMAGE_FRAGMENT}
  ${ADDRESS_FRAGMENT}
  fragment OrderFields on Order {
    id
    orderNumber
    name
    processedAt
    fulfillmentStatus
    financialStatus
    statusUrl
    currencyCode
    email
    phone
    totalPrice { ...MoneyFields }
    subtotalPrice { ...MoneyFields }
    totalShippingPrice { ...MoneyFields }
    totalTax { ...MoneyFields }
    totalRefunded { ...MoneyFields }
    shippingAddress { ...AddressFields }
    lineItems(first: 50) {
      nodes {
        title
        quantity
        originalTotalPrice { ...MoneyFields }
        discountedTotalPrice { ...MoneyFields }
        variant {
          id
          title
          sku
          availableForSale
          quantityAvailable
          price { ...MoneyFields }
          compareAtPrice { ...MoneyFields }
          selectedOptions { name value }
          image { ...ImageFields }
        }
      }
    }
  }
`;

export const CUSTOMER_ORDERS_QUERY = /* GraphQL */ `
  ${ORDER_FRAGMENT}
  query CustomerOrders($accessToken: String!, $first: Int!, $after: String) {
    customer(customerAccessToken: $accessToken) {
      orders(first: $first, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        nodes { ...OrderFields }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
`;

export const CUSTOMER_ORDER_BY_ID_QUERY = /* GraphQL */ `
  ${ORDER_FRAGMENT}
  query CustomerOrderById($accessToken: String!) {
    customer(customerAccessToken: $accessToken) {
      orders(first: 250, sortKey: PROCESSED_AT, reverse: true) {
        nodes { ...OrderFields }
      }
    }
  }
`;

// Blogs / Articles

export const BLOG_FRAGMENT = /* GraphQL */ `
  fragment BlogFields on Blog {
    id
    handle
    title
  }
`;

export const ARTICLE_FRAGMENT = /* GraphQL */ `
  ${IMAGE_FRAGMENT}
  ${BLOG_FRAGMENT}
  fragment ArticleFields on Article {
    id
    handle
    title
    content
    contentHtml
    excerpt
    excerptHtml
    publishedAt
    tags
    image { ...ImageFields }
    authorV2 {
      name
      email
      bio
    }
    blog { ...BlogFields }
  }
`;

export const BLOGS_LIST_QUERY = /* GraphQL */ `
  ${BLOG_FRAGMENT}
  query Blogs($first: Int!, $after: String, $query: String, $sortKey: BlogSortKeys, $reverse: Boolean) {
    blogs(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      nodes { ...BlogFields }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

export const BLOG_BY_HANDLE_QUERY = /* GraphQL */ `
  ${BLOG_FRAGMENT}
  query BlogByHandle($handle: String!) {
    blog(handle: $handle) { ...BlogFields }
  }
`;

export const BLOG_ARTICLES_QUERY = /* GraphQL */ `
  ${ARTICLE_FRAGMENT}
  query BlogArticles($handle: String!, $first: Int!, $after: String, $sortKey: ArticleSortKeys, $reverse: Boolean) {
    blog(handle: $handle) {
      articles(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse) {
        nodes { ...ArticleFields }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
`;

export const BLOG_ARTICLE_BY_HANDLE_QUERY = /* GraphQL */ `
  ${ARTICLE_FRAGMENT}
  query BlogArticleByHandle($blogHandle: String!, $articleHandle: String!) {
    blog(handle: $blogHandle) {
      articleByHandle(handle: $articleHandle) { ...ArticleFields }
    }
  }
`;

// Wishlist — batch product hydration by ID

/** Deleted or access-denied products come back as `null`, position-preserved. */
export const NODES_AS_PRODUCTS_QUERY = /* GraphQL */ `
  ${PRODUCT_CARD_FRAGMENT}
  query WishlistNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product { ...ProductCardFields }
    }
  }
`;

export const SHOP_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      name
      moneyFormat
      paymentSettings {
        currencyCode
      }
    }
  }
`;

/** Each variant carries enough of its parent product to render a card without a second trip. */
export const NODES_AS_VARIANTS_QUERY = /* GraphQL */ `
  ${VARIANT_FRAGMENT}
  query VariantNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant {
        ...VariantFields
        sellingPlanAllocations(first: 1) {
          nodes {
            sellingPlan { id name }
            remainingBalanceChargeAmount { ...MoneyFields }
          }
        }
        product {
          id
          title
          handle
          featuredImage { ...ImageFields }
          media(first: 250) { nodes { mediaContentType } }
        }
      }
    }
  }
`;
