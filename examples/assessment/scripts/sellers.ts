// The three demo sellers. Ledgerly is a marketplace for creators' digital goods.
export const SELLERS = [
  {
    externalId: "seller_us_mira",
    email: "owner@example.com",
    country: "US",
    title: "Mira Presets",
    collectionMode: "direct",
  },
  {
    externalId: "seller_de_vorlage",
    email: "seller+ledgerly-de@example.com",
    country: "DE",
    title: "Vorlage Studio",
    collectionMode: "direct",
  },
  {
    externalId: "seller_br_batida",
    email: "seller+ledgerly-br@example.com",
    country: "BR",
    title: "Batida Samples",
    // Ledgerly policy: this seller never takes payments directly; Ledgerly charges and transfers.
    collectionMode: "platform",
  },
] as const;
