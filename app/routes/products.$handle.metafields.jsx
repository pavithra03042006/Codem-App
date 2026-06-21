import { authenticate } from "../shopify.server";

// ─── Lazy metafields loader ───────────────────────────────────────────────────
// This route is called on-demand by metaFetcher.load() when the user
// clicks the Metafields tab for the first time. It is never called on
// initial page load, saving an API round-trip when the tab is never visited.

export async function loader({ request, params }) {
    
  const handle = params.handle;
  console.log("⚡ Metafields loader called for:", handle);
  if (!handle) {
    throw new Response("Handle is required", { status: 400 });
  }

  let admin;
  try {
    ({ admin } = await authenticate.admin(request));
  } catch (err) {
    console.error("E-03: Unauthorized session", err);
    throw new Response("E-03: Unauthorized session — Session auth failure.", {
      status: 401,
    });
  }

  const response = await admin.graphql(//Fetch metafields for the product by handle
    `query MetafieldsByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        metafields(first: 50) {
          nodes { id namespace key type value }
        }
      }
    }`,
    { variables: { handle } },
  );

  const result = await response.json();
  const metafields =
    result.data.productByHandle?.metafields.nodes ?? [];//Extract metafields from response, default to empty array if none

  return { metafields };
}