// The three demo sellers. Ledgerly is a marketplace for creators' digital goods.
// The proof run used real inboxes; they're replaced with placeholders here.
export const SELLERS = [
  {
    externalId: "seller_us_mira",
    email: "mira@seller.example",
    country: "US",
    title: "Mira Presets",
    collectionMode: "direct",
  },
  {
    externalId: "seller_de_vorlage",
    email: "vorlage@seller.example",
    country: "DE",
    title: "Vorlage Studio",
    collectionMode: "direct",
  },
  {
    externalId: "seller_br_batida",
    email: "batida@seller.example",
    country: "BR",
    title: "Batida Samples",
    // Ledgerly policy: this seller never takes payments directly; Ledgerly charges and transfers.
    collectionMode: "platform",
  },
] as const;
