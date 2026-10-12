import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import dns from "dns";
import assert from "assert";

dns.setServers(["1.1.1.1", "8.8.8.8"]);
dotenv.config({ path: path.join(__dirname, "../../.env") });

import Product from "../modules/products/product.model";
import ProductMapping from "../modules/product-mappings/product-mapping.model";
import { csvImportService } from "../modules/csv-import/csv-import.service";

async function runCsvImportTests() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("No MONGO_URI in environment");
  await mongoose.connect(uri);
  console.log("Connected to MongoDB for CSV Import testing");

  const timestamp = Date.now();
  const testSku1 = `SKU-CSV-TEST-A-${timestamp}`;
  const testSku2 = `SKU-CSV-TEST-B-${timestamp}`;
  const testSkuSoftDeleted = `SKU-CSV-TEST-DEL-${timestamp}`;
  const mockUserId = new mongoose.Types.ObjectId().toString();

  try {
    // PREPARATION: Create a soft-deleted product to test soft-deleted restore/update
    await Product.create({
      sku: testSkuSoftDeleted,
      title: "Soft Deleted Product",
      price: 10,
      quantity: 5,
      isDeleted: true,
      userId: mockUserId,
    });
    console.log(`✅ Created initial soft-deleted product: ${testSkuSoftDeleted}`);

    const initialProductCount = await Product.countDocuments({ isDeleted: false });

    // =========================================================================
    // TEST 1: Import a completely new SKU
    // =========================================================================
    console.log("\n--- TEST 1: Import a completely new SKU ---");
    const csvContent1 = `sku,title,description,brand,category,price,quantity,shippingCharge,status
${testSku1},Brand New Product,Testing description,TestBrand,Electronics,49.99,25,4.99,ACTIVE`;

    const summary1 = await csvImportService.importProducts(Buffer.from(csvContent1), mockUserId);
    console.log("Summary 1:", summary1);

    assert.strictEqual(summary1.totalRows, 1, "Total rows should be 1");
    assert.strictEqual(summary1.created, 1, "Created count should be 1");
    assert.strictEqual(summary1.updated, 0, "Updated count should be 0");
    assert.strictEqual(summary1.failed, 0, "Failed count should be 0");

    const createdProd1 = await Product.findOne({ sku: testSku1, isDeleted: false });
    assert(createdProd1, "Product should exist in MongoDB");
    assert.strictEqual(createdProd1?.title, "Brand New Product");
    assert.strictEqual(createdProd1?.price, 49.99);
    assert.strictEqual(createdProd1?.quantity, 25);
    console.log("✅ TEST 1 Passed: New product successfully created!");

    // =========================================================================
    // TEST 2: Upload the same CSV again (product count must not increase, must UPDATE)
    // =========================================================================
    console.log("\n--- TEST 2: Upload the same CSV again with updated values ---");
    const countAfterTest1 = await Product.countDocuments({ isDeleted: false });

    const csvContent2 = `sku,title,description,brand,category,price,quantity,shippingCharge,status
${testSku1},Brand New Product Updated,Testing updated description,TestBrand,Electronics,59.99,35,0.00,ACTIVE`;

    const summary2 = await csvImportService.importProducts(Buffer.from(csvContent2), mockUserId);
    console.log("Summary 2:", summary2);

    assert.strictEqual(summary2.totalRows, 1, "Total rows should be 1");
    assert.strictEqual(summary2.created, 0, "Created count should be 0");
    assert.strictEqual(summary2.updated, 1, "Updated count should be 1");
    assert.strictEqual(summary2.failed, 0, "Failed count should be 0");

    const countAfterTest2 = await Product.countDocuments({ isDeleted: false });
    assert.strictEqual(countAfterTest1, countAfterTest2, "Product count must NOT increase when uploading same CSV again");

    const updatedProd1 = await Product.findOne({ sku: testSku1, isDeleted: false });
    assert.strictEqual(updatedProd1?.title, "Brand New Product Updated", "Title should be updated");
    assert.strictEqual(updatedProd1?.price, 59.99, "Price should be updated");
    assert.strictEqual(updatedProd1?.quantity, 35, "Quantity should be updated");
    assert.strictEqual(updatedProd1?.shippingCharge, 0, "Shipping charge should be updated");
    console.log("✅ TEST 2 Passed: Existing product updated and product count did not increase!");

    // =========================================================================
    // TEST 3: Import a CSV containing an existing SKU that was soft-deleted
    // =========================================================================
    console.log("\n--- TEST 3: Import a CSV containing a soft-deleted SKU ---");
    const csvContent3 = `sku,title,price,quantity,status
${testSkuSoftDeleted},Restored and Updated Product,89.50,50,ACTIVE`;

    const summary3 = await csvImportService.importProducts(Buffer.from(csvContent3), mockUserId);
    console.log("Summary 3:", summary3);

    assert.strictEqual(summary3.totalRows, 1, "Total rows should be 1");
    assert.strictEqual(summary3.created, 0, "Created count should be 0");
    assert.strictEqual(summary3.updated, 1, "Updated count should be 1 (restored/updated)");
    assert.strictEqual(summary3.failed, 0, "Failed count should be 0");

    const restoredProd = await Product.findOne({ sku: testSkuSoftDeleted });
    assert(restoredProd, "Restored product should exist");
    assert.strictEqual(restoredProd?.isDeleted, false, "Product should now have isDeleted: false");
    assert.strictEqual(restoredProd?.title, "Restored and Updated Product");
    assert.strictEqual(restoredProd?.price, 89.50);
    console.log("✅ TEST 3 Passed: Soft-deleted product restored & updated cleanly without E11000 error!");

    // =========================================================================
    // TEST 4: Mixed CSV containing both existing SKU and new SKU
    // =========================================================================
    console.log("\n--- TEST 4: Mixed CSV with existing SKU and brand new SKU ---");
    const csvContent4 = `sku,title,price,quantity,status
${testSku1},Product 1 Re-updated,69.99,40,ACTIVE
${testSku2},Product 2 Brand New,19.99,10,ACTIVE`;

    const summary4 = await csvImportService.importProducts(Buffer.from(csvContent4), mockUserId);
    console.log("Summary 4:", summary4);

    assert.strictEqual(summary4.totalRows, 2, "Total rows should be 2");
    assert.strictEqual(summary4.created, 1, "Created count should be 1 (for testSku2)");
    assert.strictEqual(summary4.updated, 1, "Updated count should be 1 (for testSku1)");
    assert.strictEqual(summary4.failed, 0, "Failed count should be 0");
    console.log("✅ TEST 4 Passed: Mixed batch correctly identified 1 Created, 1 Updated, 0 Failed!");

    // =========================================================================
    // TEST 5: CSV with invalid rows (row-level isolation)
    // =========================================================================
    console.log("\n--- TEST 5: Independent row validation & failure reporting ---");
    const csvContent5 = `sku,title,price,quantity,status
${testSku1},Valid Row,75.00,15,ACTIVE
SKU-NEW-NOTITLE,,25.00,10,ACTIVE
SKU-INVALID-PRICE,Bad Price Product,-10.00,10,ACTIVE
${testSku1},Duplicate In Same CSV,50.00,10,ACTIVE`;

    const summary5 = await csvImportService.importProducts(Buffer.from(csvContent5), mockUserId);
    console.log("Summary 5:", summary5);

    assert.strictEqual(summary5.totalRows, 4, "Total rows should be 4");
    assert.strictEqual(summary5.created, 0, "Created count should be 0");
    assert.strictEqual(summary5.updated, 1, "Updated count should be 1 (the 1 valid row)");
    assert.strictEqual(summary5.failed, 3, "Failed count should be 3 (3 invalid rows)");
    assert.strictEqual(summary5.errors.length, 3, "Should return 3 error items");
    console.log("✅ TEST 5 Passed: Problematic rows did not stop valid rows!");

    // =========================================================================
    // TEST 6: Verify NO ProductMapping records were created
    // =========================================================================
    console.log("\n--- TEST 6: Verify ProductMapping records were not created ---");
    const mappingsCreated = await ProductMapping.countDocuments({
      sku: { $in: [testSku1, testSku2, testSkuSoftDeleted] },
    });
    assert.strictEqual(mappingsCreated, 0, "No ProductMapping records should be created by CSV import");
    console.log("✅ TEST 6 Passed: ProductMapping isolation verified!");

    // =========================================================================
    // TEST 7: Test live database SKU-1001 (which previously threw E11000)
    // =========================================================================
    console.log("\n--- TEST 7: Test importing SKU-1001 ---");
    const csvContent7 = `sku,title,description,brand,category,images,price,quantity,shippingCharge,status
SKU-1001,Wireless Mouse,Ergonomic optical mouse,Logitech,Electronics,"https://example.com/img1.jpg",29.99,100,5.00,ACTIVE`;

    const summary7 = await csvImportService.importProducts(Buffer.from(csvContent7), mockUserId);
    console.log("Summary 7:", summary7);

    assert.strictEqual(summary7.failed, 0, "SKU-1001 import must succeed without E11000 error!");
    assert(summary7.updated === 1 || summary7.created === 1, "SKU-1001 should be updated or created");
    console.log("✅ TEST 7 Passed: SKU-1001 successfully processed with zero duplicate key errors!");

  } finally {
    // Cleanup test products
    await Product.deleteMany({
      sku: { $in: [testSku1, testSku2, testSkuSoftDeleted] },
    });
    console.log("\n🧹 Cleaned up temporary test products");
    await mongoose.disconnect();
  }

  console.log("\n🎉 ALL CSV IMPORT TESTS PASSED SUCCESSFULLY! 🎉\n");
}

runCsvImportTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
