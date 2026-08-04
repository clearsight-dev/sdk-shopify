/**
 * Shopify Storefront GraphQL fragments + operations.
 *
 * Fragments are inlined into operations as template strings — keeps
 * zero runtime deps.
 */

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

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

export const PRODUCT_FRAGMENT = /* GraphQL */ `
  ${VARIANT_FRAGMENT}
  fragment ProductFields on Product {
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
    updatedAt
    createdAt
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
    cost {
      subtotalAmount { ...MoneyFields }
      totalAmount { ...MoneyFields }
      totalTaxAmount { ...MoneyFields }
    }
    discountCodes { code applicable }
    note
    attributes { key value }
    createdAt
    updatedAt
    lines(first: 250) {
      nodes {
        id
        quantity
        cost {
          totalAmount { ...MoneyFields }
          amountPerQuantity { ...MoneyFields }
          compareAtAmountPerQuantity { ...MoneyFields }
        }
        merchandise {
          ... on ProductVariant { ...VariantFields }
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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

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
  ${PRODUCT_FRAGMENT}
  query Recommended($productId: ID!) {
    productRecommendations(productId: $productId) { ...ProductFields }
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
  ${PRODUCT_FRAGMENT}
  query CollectionProducts($handle: String!, $first: Int!, $after: String, $sortKey: ProductCollectionSortKeys, $reverse: Boolean, $filters: [ProductFilter!]) {
    collection(handle: $handle) {
      products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
        nodes { ...ProductFields }
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

export const CART_BUYER_IDENTITY_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
    cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
      cart { ...CartFields }
      userErrors { field message code }
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

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Blogs / Articles
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wishlist — batch product hydration by ID
// ---------------------------------------------------------------------------

/**
 * Fetch many products by ID in one round-trip via the Storefront `nodes`
 * root field. Deleted / access-denied products come back as `null` in
 * the returned array (position-preserved), which the caller uses to
 * prune the local wishlist.
 *
 * Batch size caps depend on Storefront query cost — practical limit is
 * ~100 IDs per call. The wishlist chunks larger sets automatically.
 */
export const NODES_AS_PRODUCTS_QUERY = /* GraphQL */ `
  ${PRODUCT_FRAGMENT}
  query WishlistNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product { ...ProductFields }
    }
  }
`;

/** Shop-level settings — money format template + currency. */
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

// ─── Cart note & attributes ───────────────────────────────────────────────
// Cart-level counterparts to the line-level `attributes` on CartLineInput.
// Both are full replaces, matching the underlying Storefront mutations.

// `note` is non-null on the Storefront mutation, so clearing means sending an
// empty string — `cart.updateNote(id, null)` maps to that.
export const CART_NOTE_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartNoteUpdate($cartId: ID!, $note: String!) {
    cartNoteUpdate(cartId: $cartId, note: $note) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

export const CART_ATTRIBUTES_UPDATE_MUTATION = /* GraphQL */ `
  ${CART_FRAGMENT}
  mutation CartAttributesUpdate($cartId: ID!, $attributes: [AttributeInput!]!) {
    cartAttributesUpdate(cartId: $cartId, attributes: $attributes) {
      cart { ...CartFields }
      userErrors { field message code }
    }
  }
`;

// ─── Metafields ───────────────────────────────────────────────────────────
// Storefront exposes metafields only by explicit identifier — there is no
// "list all" — so every query takes `[HasMetafieldsIdentifier!]!`. Missing
// identifiers come back as nulls in the array, which the caller strips.

export const METAFIELD_FRAGMENT = /* GraphQL */ `
  fragment MetafieldFields on Metafield {
    id
    namespace
    key
    value
    type
  }
`;

export const PRODUCT_METAFIELDS_QUERY = /* GraphQL */ `
  ${METAFIELD_FRAGMENT}
  query ProductMetafields($id: ID!, $identifiers: [HasMetafieldsIdentifier!]!) {
    product(id: $id) {
      metafields(identifiers: $identifiers) { ...MetafieldFields }
    }
  }
`;

export const VARIANT_METAFIELDS_QUERY = /* GraphQL */ `
  ${METAFIELD_FRAGMENT}
  query VariantMetafields($id: ID!, $identifiers: [HasMetafieldsIdentifier!]!) {
    node(id: $id) {
      ... on ProductVariant {
        metafields(identifiers: $identifiers) { ...MetafieldFields }
      }
    }
  }
`;

export const COLLECTION_METAFIELDS_QUERY = /* GraphQL */ `
  ${METAFIELD_FRAGMENT}
  query CollectionMetafields($id: ID!, $identifiers: [HasMetafieldsIdentifier!]!) {
    collection(id: $id) {
      metafields(identifiers: $identifiers) { ...MetafieldFields }
    }
  }
`;

export const CUSTOMER_METAFIELDS_QUERY = /* GraphQL */ `
  ${METAFIELD_FRAGMENT}
  query CustomerMetafields($accessToken: String!, $identifiers: [HasMetafieldsIdentifier!]!) {
    customer(customerAccessToken: $accessToken) {
      metafields(identifiers: $identifiers) { ...MetafieldFields }
    }
  }
`;

export const ORDER_METAFIELDS_QUERY = /* GraphQL */ `
  ${METAFIELD_FRAGMENT}
  query OrderMetafields($id: ID!, $identifiers: [HasMetafieldsIdentifier!]!) {
    node(id: $id) {
      ... on Order {
        metafields(identifiers: $identifiers) { ...MetafieldFields }
      }
    }
  }
`;
