"use client";

import { useRef, useState } from "react";
import { btnAccent, input, label } from "@/components/styles";
import { BUCKET, MAX_FILE_BYTES, parsePrice } from "@/lib/product-rules";
import { supabaseBrowser } from "@/lib/supabase/client";
import { createProductAction, prepareProductAction } from "../actions";

/**
 * New product. The file goes straight from the browser to Supabase Storage with a one-time
 * upload URL (so it never passes through our server's request size limit), then the server
 * checks it arrived and lists the product.
 */
export function AddProductForm() {
  const form = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file");
    const fields = {
      title: String(fd.get("title") ?? ""),
      description: String(fd.get("description") ?? ""),
      price: String(fd.get("price") ?? ""),
      fileName: file instanceof File ? file.name : "",
      fileSize: file instanceof File ? file.size : 0,
    };
    try {
      if (!(file instanceof File) || file.size === 0) throw new Error("Choose the file buyers will download");
      if (file.size > MAX_FILE_BYTES) throw new Error("Files can be at most 10 MB");
      parsePrice(fields.price);

      setStep("Preparing…");
      const prep = await prepareProductAction(fields);
      if (!prep.ok) throw new Error(prep.error);

      setStep("Uploading file…");
      const { error: upload } = await supabaseBrowser()
        .storage.from(BUCKET)
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: file.type || "application/octet-stream" });
      if (upload) throw new Error(`Upload failed: ${upload.message}`);

      setStep("Publishing…");
      const created = await createProductAction(prep.data.productId, fields);
      if (!created.ok) throw new Error(created.error);
      form.current?.reset();
      setDone(`"${fields.title.trim()}" was added to your store.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStep(null);
    }
  }

  return (
    <form ref={form} onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="title" className={label}>
          Title
        </label>
        <input id="title" name="title" required minLength={2} maxLength={100} className={input} placeholder="Golden Hour Lightroom Presets" />
      </div>
      <div>
        <label htmlFor="description" className={label}>
          Description <span className="font-normal text-subtle">(optional)</span>
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          maxLength={2000}
          className={`${input} h-auto py-2`}
          placeholder="What's included, file formats, compatible apps…"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div>
          <label htmlFor="price" className={label}>
            Price (USD)
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-subtle">$</span>
            <input id="price" name="price" required inputMode="decimal" pattern="\d{1,5}(\.\d{1,2})?" className={`${input} pl-7`} placeholder="12.00" />
          </div>
        </div>
        <div>
          <label htmlFor="file" className={label}>
            File <span className="font-normal text-subtle">(up to 10 MB)</span>
          </label>
          <input
            id="file"
            name="file"
            type="file"
            required
            className="block w-full text-sm text-muted file:mr-3 file:h-10 file:rounded-xl file:border-0 file:bg-accent-soft file:px-4 file:text-sm file:font-medium file:text-accent-ink hover:file:bg-accent-soft/70"
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-accent-ink">
          {done}
        </p>
      )}
      <button disabled={step !== null} className={btnAccent}>
        {step ?? "Add product"}
      </button>
    </form>
  );
}
