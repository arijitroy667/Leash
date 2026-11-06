import { describe, expect, it } from "vitest";
import { deliveryCheck } from "@leash/guard";
import { INVOICE_PRICES, invoiceResponse } from "@leash/merchant";

const SCHEMA = ["invoiceId", "total", "currency"]; // leash.schema on leash-invoice.eth

describe("invoice merchant", () => {
  it("every route delivers what its ENS schema promises", () => {
    for (const path of Object.keys(INVOICE_PRICES)) {
      const body = JSON.stringify(invoiceResponse(path, {}));
      expect(deliveryCheck({ status: 200, contentType: "application/json", body, schema: SCHEMA })).toEqual({ ok: true });
    }
  });

  it("does what the request asks", () => {
    const inv = invoiceResponse("/invoice", { customer: "Mumbai Bots", item: "OCR", qty: "3", unitPrice: "200" }) as any;
    expect(inv).toMatchObject({ customer: "Mumbai Bots", subtotal: 600, tax: 108, total: 708, currency: "INR" });
    expect((invoiceResponse("/tax", { amount: "1000" }) as any).total).toBe(1180);
    expect((invoiceResponse("/batch", { count: "50" }) as any).count).toBe(20);
  });

  it("strips markup from merchant-echoed text", () => {
    expect((invoiceResponse("/invoice", { customer: "<script>x</script>" }) as any).customer).toBe("scriptxscript");
  });
});
