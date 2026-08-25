export interface CatalogImage {
  id: number;
  name: string;
  mimeType: string;
  /** base64-encoded image bytes, no `data:` prefix */
  imageData: string;
  width: number;
  height: number;
  sortOrder: number;
}

export interface CatalogLink {
  id: number;
  imageId: number;
  /** label shown on the image at the hotspot; unique across the whole catalog */
  name: string;
  /** join key against CatalogRow.url; unique across the whole catalog */
  url: string;
  top: number;
  left: number;
  fontSize: number;
}

export interface CatalogRow {
  id: number;
  imageId: number;
  /** matches a CatalogLink.url on the same image */
  url: string;
  name: string;
  sku: string;
  description: string;
  /** free-form characteristics that vary per catalog/image, e.g. { "weight": "2.3 kg" } */
  extra: Record<string, string>;
}

export interface CatalogMeta {
  schemaVersion: number;
  catalogName: string;
  createdBy: string;
  createdAt: string;
}

/** Thrown when a link name/url (or row url) would collide with an existing one. */
export class UniquenessError extends Error {
  constructor(public readonly field: "name" | "url", public readonly value: string) {
    super(`"${value}" is already used as a link ${field} elsewhere in this catalog`);
    this.name = "UniquenessError";
  }
}
