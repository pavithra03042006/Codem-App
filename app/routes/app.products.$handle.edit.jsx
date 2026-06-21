import { useLoaderData, useFetcher, useParams } from "react-router";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";

export async function loader({ request, params }) {
  const handle = params.handle;
  if (!handle) {
    throw new Response("Handle is required to load product", { status: 400 });
  }

  let admin;
  try {
    ({ admin } = await authenticate.admin(request));
  } catch (err) {
    console.error("E-03: Unauthorized session", err);
    return {
      productId: null,
      productTitle: null,
      variants: [],
      shopWeightUnit: null,
      productMedia: [],
      productNotFound: false,
      authError: true,
    };
  }

  const response = await admin.graphql(
    `query ProductByHandle($handle: String!) {
      shop { weightUnit }
      productByHandle(handle: $handle) {
        id
        title
        media(first: 20) {
          nodes {
            id
            ... on MediaImage { image { url } }
          }
        }
        variants(first: 100) {
          nodes {
            id
            title
            price
            inventoryItem {
              id
              sku
              measurement { weight { value unit } }
            }
            media(first: 1) {
              nodes {
                ... on MediaImage { id image { url } }
              }
            }
          }
        }
      }
    }`,
    { variables: { handle } },
  );

  const result = await response.json();
  const product = result.data.productByHandle;

  if (!product) {
    return {
      productId: null,
      productTitle: null,
      variants: [],
      shopWeightUnit: null,
      productMedia: [],
      productNotFound: true,
    };
  }

  return {
    productId: product.id,
    productTitle: product.title,
    variants: product.variants.nodes ?? [],
    shopWeightUnit: result.data.shop.weightUnit,
    productMedia: product.media.nodes ?? [],
    productNotFound: false,
  };
}

export async function action({ request, params }) {
  const handle = params.handle;
  if (!handle) {
    throw new Response("Handle is required to update product", { status: 400 });
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

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "updateVariant") {
    const productId = form.get("productId");
    const variantId = form.get("variantId");
    const field = form.get("field");
    const value = form.get("value");

    if (field === "price") {
      const num = Number(value);
      if (isNaN(num) || num <= 0)
        return {
          errors: [
            { field: "price", message: "Price must be a positive number" },
          ],
        };
      if (!/^\d+(\.\d{1,2})?$/.test(value))
        return {
          errors: [
            { field: "price", message: "Price must have max 2 decimal places" },
          ],
        };
    }
    if (field === "weight") {
      const num = Number(value);
      if (isNaN(num) || num <= 0)
        return {
          errors: [
            { field: "weight", message: "Weight must be a positive number" },
          ],
        };
    }

    const variantInput = { id: variantId };
    if (field === "price") variantInput.price = value;
    if (field === "sku") variantInput.inventoryItem = { sku: value };
    if (field === "weight") {
      variantInput.inventoryItem = {
        measurement: {
          weight: { value: parseFloat(value), unit: form.get("unit") },
        },
      };
    }
    if (field === "media") variantInput.mediaId = value;

    let response;
    try {
      response = await admin.graphql(
        `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              media(first: 1) {
                nodes { ... on MediaImage { id image { url } } }
              }
            }
            userErrors { field message }
          }
        }`,
        { variables: { productId, variants: [variantInput] } },
      );
    } catch (err) {
      console.error("E-07: Variant mutation failure", err);
      return {
        errors: [
          {
            field: "general",
            message:
              "E-07: Unable to update product right now. Please try again.",
          },
        ],
      };
    }

    const result = await response.json();
    const userErrors = result.data.productVariantsBulkUpdate.userErrors;
    if (userErrors.length > 0) {
      const skuTaken = userErrors.find(
        (e) =>
          e.message.toLowerCase().includes("already") ||
          e.message.toLowerCase().includes("taken"),
      );
      if (field === "sku" && skuTaken) {
        return {
          errors: [
            {
              field: "sku",
              message: "E-10: SKU must be unique, this one is already in use",
            },
          ],
        };
      }
      return { errors: userErrors };
    }
    return { result: result.data.productVariantsBulkUpdate };
  }

  if (intent === "saveMetafield") {
    const ownerId = form.get("ownerId");
    const namespace = form.get("namespace");
    const key = form.get("key");
    const type = form.get("type");
    const value = form.get("value");
    const lowerNoSpace = /^[a-z0-9_]+$/;

    if (!namespace || !lowerNoSpace.test(namespace))
      return {
        metafieldErrors: [
          { field: "namespace", message: "Required. Lowercase, no spaces." },
        ],
      };
    if (!key || !lowerNoSpace.test(key))
      return {
        metafieldErrors: [
          { field: "key", message: "Required. Lowercase, no spaces." },
        ],
      };
    if (value === "" || value === null)
      return {
        metafieldErrors: [{ field: "value", message: "Value is required." }],
      };
    if (type === "integer" && !/^-?\d+$/.test(value))
      return {
        metafieldErrors: [
          { field: "value", message: "Value must be an integer." },
        ],
      };
    if (type === "boolean" && value !== "true" && value !== "false")
      return {
        metafieldErrors: [
          { field: "value", message: "Value must be true or false." },
        ],
      };
    if (type === "json") {
      try {
        JSON.parse(value);
      } catch {
        return {
          metafieldErrors: [
            { field: "value", message: "Value must be valid JSON." },
          ],
        };
      }
    }

    const typeMap = {
      single_line_text_field: "single_line_text_field",
      integer: "number_integer",
      boolean: "boolean",
      json: "json",
    };

    let response;
    try {
      response = await admin.graphql(
        `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key type value }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              { ownerId, namespace, key, type: typeMap[type] || type, value },
            ],
          },
        },
      );
    } catch (err) {
      console.error("E-07: Metafield mutation failure", err);
      return {
        metafieldErrors: [
          {
            field: "general",
            message:
              "E-07: Unable to update product right now. Please try again.",
          },
        ],
      };
    }

    const result = await response.json();
    const userErrors = result.data.metafieldsSet.userErrors;
    if (userErrors.length > 0) return { metafieldErrors: userErrors };
    return {
      metafieldResult: result.data.metafieldsSet.metafields[0],
      _rowKey: form.get("_rowKey"),
    };
  }

  if (intent === "deleteMetafield") {
    const ownerId = form.get("ownerId");
    const namespace = form.get("namespace");
    const key = form.get("key");

    let response;
    try {
      response = await admin.graphql(
        `mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { key namespace ownerId }
            userErrors { field message }
          }
        }`,
        { variables: { metafields: [{ ownerId, namespace, key }] } },
      );
    } catch (err) {
      console.error("E-07: Delete metafield failure", err);
      return {
        metafieldErrors: [
          {
            field: "general",
            message:
              "E-07: Unable to update product right now. Please try again.",
          },
        ],
      };
    }

    const result = await response.json();
    const userErrors = result.data.metafieldsDelete.userErrors;
    if (userErrors.length > 0) return { metafieldErrors: userErrors };
    const deleted = result.data.metafieldsDelete.deletedMetafields[0];
    return {
      deletedKey: deleted ? `${deleted.namespace}.${deleted.key}` : null,
    };
  }

  return null;
}

const apiTypeToDisplayType = {
  single_line_text_field: "single_line_text_field",
  number_integer: "integer",
  boolean: "boolean",
  json: "json",
};

function initVariantDraft(variants) {
  const map = {};
  for (const v of variants) {
    map[v.id] = {
      price: v.price,
      sku: v.inventoryItem?.sku || "",
      weight: v.inventoryItem?.measurement?.weight?.value ?? "",
      unit: v.inventoryItem?.measurement?.weight?.unit ?? "",
      mediaId: v.media?.nodes?.[0]?.id ?? null,
    };
  }
  return map;
}

function initMetaDraft(metafields) {
  return metafields.map((m) => ({
    ...m,
    type: apiTypeToDisplayType[m.type] ?? m.type,
    _isNew: false,
    _error: null,
    _rowKey: m.id,
    _deleted: false,
  }));
}

function variantDraftsEqual(a, b) {
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  for (const id of Object.keys(a)) {
    const av = a[id],
      bv = b[id];
    if (!bv) return false;
    if (
      av.price !== bv.price ||
      av.sku !== bv.sku ||
      av.weight !== bv.weight ||
      av.mediaId !== bv.mediaId
    )
      return false;
  }
  return true;
}

function metaDraftsEqual(a, b) {
  const aActive = a.filter((m) => !m._deleted && !m._isNew);
  const bActive = b.filter((m) => !m._deleted && !m._isNew);
  if (aActive.length !== bActive.length) return false;
  for (let i = 0; i < aActive.length; i++) {
    if (
      aActive[i].value !== bActive[i].value ||
      aActive[i].type !== bActive[i].type
    )
      return false;
  }
  const aNew = a.filter((m) => m._isNew);
  const bNew = b.filter((m) => m._isNew);
  if (aNew.length !== bNew.length) return false;
  const aDel = a.filter((m) => m._deleted);
  const bDel = b.filter((m) => m._deleted);
  if (aDel.length !== bDel.length) return false;
  return true;
}

export default function VariantsByHandle() {
  const params = useParams(); 

  const {
    productId,
    productTitle,
    variants,
    shopWeightUnit,
    productMedia,
    productNotFound,
    authError,
  } = useLoaderData(); 

  const VALID_TABS = ["variants", "metafields"]; 
  const [activeTab, setActiveTabRaw] = useState("variants");

  
  const [tabError, setTabError] = useState(null); 

  function setActiveTab(tab) {
    if (
      !VALID_TABS.includes(tab)
    ) 
    {
      setTabError(`E-06: Unsupported tab — Unknown _tab value: "${tab}"`);
      return;
    }
    setTabError(null);
    setSuccessMsg(null); 
    setActiveTabRaw(tab); 
  }

  const [variantDraft, setVariantDraft] = useState(() =>
    initVariantDraft(variants),
  );
  

  
  const [metaDraft, setMetaDraft] = useState([]);
  
  const originalVariantDraft = useRef(initVariantDraft(variants));
  const originalMetaDraft = useRef([]); 

  const [variantMedia, setVariantMedia] = useState(() => {
    const map = {};
    for (const v of variants) map[v.id] = v.media?.nodes?.[0]?.image ?? null;
    return map;
  }); 

  const [fieldErrors, setFieldErrors] = useState({});
  
  const [generalError, setGeneralError] = useState(null);
  
  const isDirty =
    !variantDraftsEqual(variantDraft, originalVariantDraft.current) ||
    !metaDraftsEqual(metaDraft, originalMetaDraft.current); 

  const variantFetcher = useFetcher(); 

  const metaFetcher = useFetcher();

  
  const metafieldsLoaded = useRef(false); 

  const [isSaving, setIsSaving] = useState(false); 
  const [successMsg, setSuccessMsg] = useState(null); 
  const pendingSaves = useRef(0);
  

  function validateVariantField(field, value) {
    if (field === "price") {
      const num = Number(value);
      if (value === "" || isNaN(num) || num <= 0)
        return "Price must be a positive number";
      if (!/^\d+(\.\d{1,2})?$/.test(String(value)))
        return "Max 2 decimal places";
    }
    if (field === "weight") {
      const num = Number(value);
      if (value === "" || isNaN(num) || num <= 0)
        return "Weight must be a positive number";
    }
    return null;
  }
  

  function updateVariantDraftField(
    variantId,
    field,
    value,
  )  {
    const error = validateVariantField(field, value); 
    setFieldErrors((prev) => {
      const updated = { ...prev }; 
      if (field === "sku") {
        for (const id of Object.keys(
          updated,
        ))  {
          updated[id] = { ...(updated[id] || {}), sku: null }; 
        }
      }
      updated[variantId] = { ...(updated[variantId] || {}), [field]: error }; 
      return updated;
    });
    setVariantDraft((prev) => ({
      
      ...prev, 
      [variantId]: { ...prev[variantId], [field]: value }, 
    }));
  }

  function addMetafieldRow() {
    
    const rowKey = `new-${Date.now()}`; 
    setMetaDraft((prev) => [
      
      ...prev, 
      {
        
        id: null, 
        namespace: "", 
        key: "", 
        type: "single_line_text_field", 
        value: "", 
        _isNew: true, 
        _rowKey: rowKey, 
        _error: null, 
        _deleted: false, 
      },
    ]);
  }

  function updateMetafieldLocal(rowKey, field, value) {
    
    setMetaDraft(
      (
        prev, 
      ) =>
        prev.map((m) => {
          
          if (m._rowKey === rowKey) {
            
            if (field === "type") {
              
              return {
                ...m, 
                type: value, 
                value: "", 
                _error: null, 
              }; 
            }
            const updatedMeta = {
              ...m, 
              [field]: value, 
            };
            
            if (field === "value") {
              
              let error = null;
              if (value.trim() === "") {
                
                error = "Value is required.";
              } else if (
                updatedMeta.type === "integer" &&
                !/^-?\d+$/.test(value) 
              ) {
                error = "Value must be an integer.";
              } else if (
                
                updatedMeta.type === "boolean" &&
                value !== "true" &&
                value !== "false"
              ) {
                error = "Value must be true or false.";
              } else if (updatedMeta.type === "json") {
                try {
                  const parsed = JSON.parse(value); 
                  if (typeof parsed !== "object" || parsed === null) {
                    error = "Value must be a valid JSON object {} or array [].";
                  }
                } catch (e) {
                  error = "Value must be valid JSON.";
                }
              }
              updatedMeta._error = error; 
            }
            return updatedMeta; 
          }
          return m; 
        }),
    );
  }
  
  
  function deleteMetafieldRow(row, rowKey) {
    
    if (row.id === null) {
      
      setMetaDraft((prev) => prev.filter((m) => m._rowKey !== rowKey)); 
    } else {
      
      setMetaDraft(
        (prev) =>
          prev.map((m) =>
            m._rowKey === rowKey ? { ...m, _deleted: true } : m,
          ), 
      );
    }
  }

  
  
  useEffect(() => {
    
    if (!variantFetcher.data) return; 
    const { result, errors } = variantFetcher.data; 
    if (result?.productVariants?.[0]) {
      
      const updated = result.productVariants[0]; 
      setVariantMedia((prev) => ({
        
        ...prev, 
        [updated.id]: updated.media?.nodes?.[0]?.image ?? prev[updated.id], 
      }));
       setSuccessMsg("Variant updated successfully.");
    }
    if (errors?.length) {
      
      if (errors[0].field === "general") {
        
        setGeneralError(errors[0].message); 
      } else {
        const variantId = variantFetcher.formData?.get("variantId"); 
        const field = variantFetcher.formData?.get("field"); 
        setFieldErrors((prev) => ({
          
          ...prev, 
          [variantId]: { ...prev[variantId], [field]: errors[0].message }, 
        }));
      }
    }
  }, [variantFetcher.data]); 

  
  
  useEffect(() => {
    if (!metaFetcher.data) return; 
    const { metafieldResult, metafieldErrors, deletedKey, _rowKey } =
      metaFetcher.data; 
    
    if (metafieldResult) {
      
      const updated = {
        ...metafieldResult, 
        type:
          apiTypeToDisplayType[metafieldResult.type] ?? metafieldResult.type, 
        _isNew: false, 
        _error: null, 
        _rowKey: metafieldResult.id, 
        _deleted: false, 
      };
      setMetaDraft(
        (
          prev, 
        ) => prev.map((m) => (m._rowKey === _rowKey ? updated : m)), 
        
      );
      setSuccessMsg("Metafield updated successfully.");
    }
    if (deletedKey) {
      
      const [ns, k] = deletedKey.split("."); 
      setMetaDraft(
        (
          prev, 
        ) => prev.filter((m) => !(m.namespace === ns && m.key === k)), 
      );
        setSuccessMsg("Metafield deleted.");
    }
    if (metafieldErrors?.length) {
      
      const rowKey = metaFetcher.formData?.get("_rowKey"); 
      setMetaDraft(
        (
          prev, 
        ) =>
          prev.map(
            (
              m, 
            ) =>
              m._rowKey === rowKey 
                ? {
                    ...m, 
                    _error: metafieldErrors[0].message, 
                  }
                : m, 
          ),
      );
      
    }
  }, [metaFetcher.data]); 

  
  
  useEffect(() => {
    if (metaFetcher.data?.metafields) {
      
      const draft = initMetaDraft(metaFetcher.data.metafields); 
      setMetaDraft(draft); 
      originalMetaDraft.current = JSON.parse(JSON.stringify(draft)); 
      
      metafieldsLoaded.current = true; 
    }
  }, [metaFetcher.data]); 

  function validatePayload(productId, variants, metaDraft) {
    
    if (!productId || typeof productId !== "string") {
      
      return "E-05: Invalid product payload — productId is missing or malformed.";
    }
    if (!Array.isArray(variants) || variants.length === 0) {
      
      return "E-05: Invalid product payload — variants array is missing or empty.";
    }
    for (const v of variants) {
      
      if (!v.id || typeof v.id !== "string") {
        
        return "E-05: Invalid product payload — variant is missing an id.";
      }
    }
    if (!Array.isArray(metaDraft)) {
      
      return "E-05: Invalid product payload — metafields data is malformed.";
    }
    return null;
  }

  async function handleSave() {
    
    if (!isDirty) return; 

    const payloadError = validatePayload(productId, variants, metaDraft); 
    if (payloadError) {
      setGeneralError(payloadError);
      return;
    } 

    let hasErrors = false; 
    for (const v of variants) {
      
      const draft = variantDraft[v.id]; 
      const priceErr =
        draft.price !== "" ? validateVariantField("price", draft.price) : null; 
      const weightErr =
        draft.weight !== ""
          ? validateVariantField("weight", draft.weight)
          : null; 
      if (priceErr || weightErr) {
        
        setFieldErrors((prev) => ({
          ...prev, 
          [v.id]: {
            
            ...prev[v.id], 
            ...(priceErr ? { price: priceErr } : {}),
            ...(weightErr ? { weight: weightErr } : {}), 
          },
        }));
        hasErrors = true;
      }
    }
    if (hasErrors) return;

    const skuMap = {};
    for (const v of variants) {
      const sku = variantDraft[v.id].sku.trim(); 
      if (!sku) continue; 
      if (skuMap[sku]) {
        
        setFieldErrors((prev) => ({
          ...prev,
          [v.id]: {
            
            ...(prev[v.id] || {}), 
            sku: `SKU "${sku}" is already used by another variant.`,
          },
          [skuMap[sku]]: {
            
            ...(prev[skuMap[sku]] || {}), 
            sku: `SKU "${sku}" is already used by another variant.`,
          },
        }));
        hasErrors = true;
      } else {
        skuMap[sku] = v.id;
      }
    }
    if (hasErrors) return;

    setIsSaving(true); 

    for (const v of variants) {
      const orig = originalVariantDraft.current[v.id]; 
      const draft = variantDraft[v.id]; 

      if (draft.price !== orig.price) {
        
        variantFetcher.submit(
          {
            intent: "updateVariant",
            productId,
            variantId: v.id,
            field: "price",
            value: String(draft.price), 
          },
          { method: "post" },
        );
      }
      if (draft.sku !== orig.sku) {
        variantFetcher.submit(
          {
            intent: "updateVariant",
            productId,
            variantId: v.id,
            field: "sku",
            value: String(draft.sku), 
          },
          { method: "post" },
        );
      }
      if (String(draft.weight) !== String(orig.weight)) {
        variantFetcher.submit(
          {
            intent: "updateVariant",
            productId,
            variantId: v.id,
            field: "weight",
            value: String(draft.weight), 
            unit: draft.unit || orig.unit || shopWeightUnit, 
          },
          { method: "post" },
        );
      }
      if (draft.mediaId !== orig.mediaId && draft.mediaId) {
        variantFetcher.submit(
          {
            intent: "updateVariant",
            productId,
            variantId: v.id,
            field: "media",
            value: draft.mediaId, 
          },
          { method: "post" },
        );
      }
    }

    for (const m of metaDraft) {
      if (m._deleted && m.id) {
        
        metaFetcher.submit(
          {
            intent: "deleteMetafield",
            ownerId: productId,
            namespace: m.namespace,
            key: m.key,
            _rowKey: m._rowKey,
          },
          { method: "post" },
        );
        continue;
      }
      if (m._isNew || m._deleted) continue; 

      const orig = originalMetaDraft.current.find(
        
        (o) => o._rowKey === m._rowKey, 
      );
      if (!orig || orig.value !== m.value || orig.type !== m.type) {
        
        metaFetcher.submit(
          {
            intent: "saveMetafield",
            ownerId: productId,
            namespace: m.namespace,
            key: m.key,
            type: m.type,
            value: m.value,
            _rowKey: m._rowKey,
          },
          { method: "post" },
        );
      }
    }

    for (const m of metaDraft.filter((m) => m._isNew && !m._deleted)) {
      
      metaFetcher.submit(
        {
          intent: "saveMetafield",
          ownerId: productId,
          namespace: m.namespace,
          key: m.key,
          type: m.type,
          value: m.value,
          _rowKey: m._rowKey,
        },
        { method: "post" },
      );
    }

    originalVariantDraft.current = JSON.parse(JSON.stringify(variantDraft)); 
    originalMetaDraft.current = JSON.parse(JSON.stringify(metaDraft));
    setIsSaving(false); 
  }

  function handleDiscard() {
    
    setVariantDraft(JSON.parse(JSON.stringify(originalVariantDraft.current))); 
    setMetaDraft(JSON.parse(JSON.stringify(originalMetaDraft.current))); 
    setFieldErrors({}); 
  }

  
  function handleMetaTabClick() {
    
    setActiveTab("metafields"); 
    setSuccessMsg(null); 
    if (!metafieldsLoaded.current) {
      
      metaFetcher.load(`/products/${params.handle}/metafields`); 
    }
  }
  const disabled = !isDirty || isSaving; 
  return (
    <div style={{ fontFamily: "cambria" }}>
    <style>{`
      input, button, select { font-family: inherit; }
    `}</style>
      <div style={headerBar}>
        <span>{productTitle || "Unknown Product"}</span>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleDiscard}
            disabled={disabled}
            style={{ ...headerBtn, opacity: disabled ? 0.5 : 1 }}
          >
            Discard
          </button>

          <button
            onClick={handleSave}
            disabled={disabled}
            style={{
              ...headerBtn,
              background: isDirty ? "#008060" : "#ccc",
            }}
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        {}
        {[
          generalError,
          tabError,
          productNotFound &&
            "E-04: Product not found — Shopify API returned null for this handle.",
          authError && "E-03: Unauthorized session — Session auth failure.",
        ]
          .filter(Boolean)
          .map((msg, i) => (
            <p
              key={i}
              style={{ color: "red", fontWeight: 600, marginBottom: 16 }}
            >
              {msg}
            </p>
          ))}
          {successMsg && (
  <p style={{ color: "#008060", fontWeight: 600, marginBottom: 16 }}>
    ✓ {successMsg}
  </p>
)} 

        {}
        <div style={{ marginBottom: 20 }}>
          {[
            {
              label: "Variants",
              tab: "variants",
              onClick: () => setActiveTab("variants"),
            },
            {
              label: "Metafields",
              tab: "metafields",
              onClick: handleMetaTabClick,
            },
          ].map(({ label, tab, onClick }) => (
            <button
              key={tab}
              onClick={onClick}
              style={{
                ...tabBtn,
                background: activeTab === tab ? "#000" : "#f3f3f4",
                color: activeTab === tab ? "#fff" : "#111",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === "variants" &&
          (variants.length === 0 ? (
            <p>No variants found</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {[
                    "Image",
                    "Title",
                    "Price",
                    "SKU",
                    "Weight",
                    "Weight Unit",
                  ].map((h) => (
                    <th key={h} style={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => {
                  const draft = variantDraft[v.id];
                  const image = variantMedia[v.id];
                  const errors = fieldErrors[v.id] || {};
                  const weightUnit =
                    draft.unit ||
                    v.inventoryItem?.measurement?.weight?.unit ||
                    shopWeightUnit ||
                    "";

                  return (
                    <tr key={v.id}>
                      {}
                      <td
                        style={{
                          ...td,
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                        }}
                      >
                        {image && (
                          <img
                            src={image.url}
                            alt=""
                            style={{
                              width: 60,
                              height: 60,
                              objectFit: "cover",
                              borderRadius: 6,
                            }}
                          />
                        )}
                        <select
                          defaultValue=""
                          style={input}
                          onChange={(e) => {
                            if (e.target.value) {
                              updateVariantDraftField(
                                v.id,
                                "mediaId",
                                e.target.value,
                              );
                              e.target.value = "";
                            }
                          }}
                        >
                          <option value="">Change image…</option>
                          {productMedia.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.id}
                            </option>
                          ))}
                        </select>
                      </td>

                      {}
                      <td style={td}>{v.title}</td>

                      {}
                      {[
                        { field: "price", type: "number" },
                        { field: "sku", type: "text" },
                        { field: "weight", type: "number" },
                      ].map(({ field, type }) => (
                        <td key={field} style={td}>
                          <input
                            type={type}
                            step={type === "number" ? "0.01" : undefined}
                            value={draft[field]}
                            style={{
                              ...input,
                              borderColor: errors[field] ? "#d00" : "#ccc",
                            }}
                            onChange={(e) =>
                              updateVariantDraftField(
                                v.id,
                                field,
                                e.target.value,
                              )
                            }
                          />
                          {errors[field] && (
                            <div style={errorText}>{errors[field]}</div>
                          )}
                        </td>
                      ))}

                      {}
                      <td style={td}>{weightUnit}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}

        {activeTab === "metafields" && (
          <div>
            {}
            {metaFetcher.state === "loading" && (
              <p style={{ color: "#888" }}>Loading metafields…</p>
            )}
            {metaFetcher.state === "idle" &&
              !metafieldsLoaded.current &&
              metaDraft.length === 0 && (
                <p style={{ color: "red" }}>
                  E-08: Unable to load metafield data right now. Please try
                  again.
                </p>
              )}

            {}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <h2 style={{ margin: 0 }}>Metafields</h2>
              <button onClick={addMetafieldRow} style={addBtn}>
                + Add New
              </button>
            </div>

            {}
            {metafieldsLoaded.current &&
              (metaDraft.filter((m) => !m._deleted).length === 0 ? (
                <p style={{ color: "#888", fontStyle: "italic", marginTop: 8 }}>
                  No metafields found for this product.
                </p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Namespace", "Key", "Type", "Value", "Del"].map((h) => (
                        <th key={h} style={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metaDraft
                      .filter((m) => !m._deleted)
                      .map((m) => {
                        const { _rowKey: rowKey, _isNew } = m;
                        const locked = !_isNew;
                        const lockedStyle = {
                          ...input,
                          background: locked ? "#f3f3f4" : "#fff",
                          cursor: locked ? "not-allowed" : "text",
                        };

                        return (
                          <tr key={rowKey}>
                            {}
                            {[
                              {
                                field: "namespace",
                                placeholder: "e.g. custom",
                              },
                              { field: "key", placeholder: "e.g. material" },
                            ].map(({ field, placeholder }) => (
                              <td key={field} style={td}>
                                <input
                                  type="text"
                                  placeholder={placeholder}
                                  value={m[field]}
                                  disabled={locked}
                                  style={lockedStyle}
                                  onChange={(e) =>
                                    updateMetafieldLocal(
                                      rowKey,
                                      field,
                                      e.target.value,
                                    )
                                  }
                                />
                              </td>
                            ))}

                            {}
                            <td style={td}>
                              <select
                                value={m.type}
                                style={input}
                                onChange={(e) =>
                                  updateMetafieldLocal(
                                    rowKey,
                                    "type",
                                    e.target.value,
                                  )
                                }
                              >
                                {[
                                  "single_line_text_field",
                                  "integer",
                                  "boolean",
                                  "json",
                                ].map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </td>

                            {}
                            <td style={td}>
                              <input
                                type="text"
                                placeholder="Value"
                                value={m.value}
                                style={input}
                                onChange={(e) =>
                                  updateMetafieldLocal(
                                    rowKey,
                                    "value",
                                    e.target.value,
                                  )
                                }
                              />
                              {m._error && (
                                <div style={errorText}>{m._error}</div>
                              )}
                            </td>

                            {}
                            <td style={td}>
                              <button
                                onClick={() => deleteMetafieldRow(m, rowKey)}
                                style={delBtn}
                              >
                                🗑
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

const headerBar = {
  position: "sticky", top: 0, zIndex: 100,
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "12px 24px", background: "#fff",
  borderBottom: "1px solid #e0e0e0", boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
};

const headerBtn = {
  padding: "8px 20px", border: "none", borderRadius: 6,
  fontWeight: 600, fontSize: 14, cursor: "pointer", transition: "opacity 0.15s",
};
const tabBtn = {
  padding: "10px 20px", border: "1px solid #ddd", borderRadius: 6,
  cursor: "pointer", marginRight: 10,
};
const addBtn = {
  padding: "8px 16px", border: "none", borderRadius: 6,
  background: "#008060", color: "white", fontWeight: 600, cursor: "pointer",
};
const delBtn = {
  border: "none", background: "transparent", cursor: "pointer", fontSize: 16,
};

const th = { padding: 10, borderBottom: "1px solid #ddd" };
const td = { padding: 10, borderBottom: "1px solid #eee", verticalAlign: "middle" };

const input = { width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 4 };
const errorText = { color: "#d00", fontSize: 12, marginTop: 4 };
