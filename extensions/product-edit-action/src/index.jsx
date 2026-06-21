import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { APP_HANDLE } from "./config.js";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { close, data } = shopify;

  useEffect(() => {
    (async function navigateToEditPage() {
      const productId = data.selected?.[0]?.id;
      if (!productId) { console.error("No product selected"); close(); return; }

      const res = await fetch("shopify:admin/api/graphql.json", {
        method: "POST",
        body: JSON.stringify({
          query: `#graphql
            query GetProductHandle($id: ID!) {
              product(id: $id) { handle }
            }
          `,
          variables: { id: productId },
        }),
      });

      if (!res.ok) { console.error("Failed to fetch product handle"); close(); return; }

      const { data: gqlData } = await res.json();
      const handle = gqlData?.product?.handle;
      if (!handle) { console.error("Product handle not found"); close(); return; }

      open(`/admin/apps/${APP_HANDLE}/app/products/${handle}/edit`, "_top");
      close();
    })();
  }, []);

  return (
    <s-admin-action>
      <s-stack direction="block">
        <s-text>Opening product editor…</s-text>
      </s-stack>
    </s-admin-action>
  );
}