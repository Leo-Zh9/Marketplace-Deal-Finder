/**
 * THE LIVE CORPUS: 141 real Facebook Marketplace titles, each with the price text it carried, the
 * search types that returned it, and a hand label. It is what `liveCorpus.test.ts` measures
 * reference-price YIELD against -- how many real standalone components get the right catalog key
 * -- and what any later change to the rule must not make worse.
 *
 * PROVENANCE. Two pulls, on 2026-11-16, of the same nine production searches (cpu x2, gpu x3,
 * motherboard, psu, ram, storage): 434 sightings, 142 listing ids, 141 distinct titles (one title
 * was listed twice under two ids and is one entry here). `searchedAs` is the union of the types
 * whose search returned the title across both pulls; the rule is run under EACH of them.
 *
 * WHAT IS NOT HERE, DELIBERATELY: listing ids, URLs, seller locations and the date a listing was
 * created. Titles are the seller's own words and are kept verbatim -- emoji, line breaks and the
 * trademark sign included -- because the tokenizer is part of what is under test. A scan for
 * phone numbers, e-mail addresses, street addresses and links found none.
 *
 * THE LABELS. Proposed from the sample, then checked title by title against src/data/catalog.ts:
 *   component(type, modelKey)  ONE standalone, working part of that type, which the catalog lists
 *                              under exactly that name. The key the rule must produce, or none.
 *   uncatalogued(type)         ONE standalone, working part of that type the catalog does not
 *                              list (or a title that does not say WHICH catalogued model it is:
 *                              `"Crucial 2tb ssd"` could be any of three). No key is right.
 *   notComponent(why)          anything else: a whole machine, a bundle, several items, an
 *                              accessory, a broken unit, a wanted ad, something that is not a PC
 *                              part at all. No key is right, under any search.
 *
 * THE JUDGEMENT CALLS, NAMED SO THEY CAN BE ARGUED WITH RATHER THAN DISCOVERED:
 *   - Laptop memory (`SODIMM`, `Laptop RAM`) is notComponent: the catalog lists desktop kits, and
 *     normalizeListing.ts already treats laptop memory as a different product.
 *   - A BROKEN part is notComponent: it is a real component, but not a price reference.
 *   - `"Gigabyte GeForce RTX 1650 4GB"` is labelled GeForce GTX 1650. There is no RTX 1650; the
 *     card the seller means is unambiguous. Today it gets no key, which the floor counts as a miss.
 *   - `"Crucial 2tb ssd"` is uncatalogued although the catalog lists three Crucial 2TB drives:
 *     the title does not say which, and guessing is a wrong key.
 *   - `"XPG ADATA"` is notComponent: it names a brand that sells both RAM and SSDs, and nothing
 *     else.
 */

import type { Listing } from "../../storage/types";

type ComponentType = Listing["componentType"];

export type LiveLabel =
  | { kind: "component"; type: ComponentType; modelKey: string }
  | { kind: "uncatalogued"; type: ComponentType }
  | { kind: "not-a-component"; why: string };

export interface LiveCorpusEntry {
  title: string;
  priceText: string | null;
  /** Every component type whose search returned this title. Never empty. */
  searchedAs: ComponentType[];
  label: LiveLabel;
}

const component = (type: ComponentType, modelKey: string): LiveLabel => ({ kind: "component", type, modelKey });
const uncatalogued = (type: ComponentType): LiveLabel => ({ kind: "uncatalogued", type });
const notComponent = (why: string): LiveLabel => ({ kind: "not-a-component", why });

export const LIVE_CORPUS: readonly LiveCorpusEntry[] = [
  { title: "16GB (4x 4GB) Micron DDR3L-1600MHz Laptop RAM – PC3L-12800S SODIMM", priceText: "CA$60", searchedAs: ["cpu", "gpu", "motherboard", "psu", "ram"], label: notComponent("laptop memory, not a desktop part") },
  { title: "Several Hard Drives", priceText: "CA$10", searchedAs: ["cpu", "gpu", "motherboard", "psu", "ram", "storage"], label: notComponent("more than one item") },
  { title: "MSI B850 Tomahawk Max Wifi Motherboard Only", priceText: "CA$260", searchedAs: ["cpu", "gpu", "motherboard", "psu", "storage"], label: component("motherboard", "MSI MAG B850 Tomahawk MAX WiFi") },
  { title: "Ram DDR4 16gb 2x8gb 3000MHz", priceText: "CA$120", searchedAs: ["cpu", "gpu", "motherboard", "ram"], label: uncatalogued("ram") },
  { title: "Intel i7-8700k", priceText: "CA$125", searchedAs: ["cpu"], label: uncatalogued("cpu") },
  { title: "AMD RYZEN 7 3800X", priceText: "CA$120", searchedAs: ["cpu"], label: uncatalogued("cpu") },
  { title: "Gaming Computer / PC", priceText: "CA$600", searchedAs: ["cpu", "gpu", "motherboard", "ram"], label: notComponent("a whole machine") },
  { title: "Bulk Lot of Key-Shaped USB Flash Drives 30 pieces", priceText: "CA$5", searchedAs: ["cpu", "gpu"], label: notComponent("more than one item") },
  { title: "1td hard drive", priceText: "CA$30", searchedAs: ["cpu", "gpu"], label: uncatalogued("storage") },
  { title: "RYZEN 5 7500F", priceText: "CA$115", searchedAs: ["cpu"], label: uncatalogued("cpu") },
  { title: "Wooting 80HE TenZ Edition Keyboard", priceText: "CA$279", searchedAs: ["cpu"], label: notComponent("a peripheral") },
  { title: "Timetec 8GB DDR3L 1600MHz Laptop RAM Module", priceText: "CA$15", searchedAs: ["cpu"], label: notComponent("laptop memory, not a desktop part") },
  { title: "Gaming PC – GTX 1080 Ti 11GB | 16GB RAM", priceText: "CA$650", searchedAs: ["cpu"], label: notComponent("a whole machine") },
  { title: "Full set or individual part", priceText: "CA$450", searchedAs: ["cpu"], label: notComponent("the title does not say what it is") },
  { title: "DeepCool Tesseract Mid-Tower ATX PC Case (No Side Panels / Open-Air Test Bench)", priceText: "CA$10", searchedAs: ["cpu"], label: uncatalogued("case") },
  { title: "Dell OptiPlex 5060 SFF PCs (2 Available) - Intel Core i7-8700 / 16GB RAM / 256GB SSD / Windows 11", priceText: "CA$190", searchedAs: ["cpu"], label: notComponent("a whole machine") },
  { title: "ASUS Motherboard CPU Combo with case included", priceText: "CA$80", searchedAs: ["cpu"], label: notComponent("a bundle of parts") },
  { title: "G.SKILL Ripjaws V 16GB (2x8GB) DDR4-3600 RAM", priceText: "CA$150", searchedAs: ["cpu"], label: component("ram", "G.Skill Ripjaws V 16GB DDR4") },
  { title: "Cobra CPI 450 Power Inverter – $40 CAD\n\nCobra 400W DC to AC Power Inverter (800W peak).\n\nIncludes:", priceText: "CA$40", searchedAs: ["cpu"], label: notComponent("not a PC item") },
  { title: "Apple iPad A16 11\" 128GB with Wi-Fi 6 (11th Generation) - Pink", priceText: "CA$600", searchedAs: ["cpu"], label: notComponent("a whole device that is not a PC part") },
  { title: "Genuine Lenovo 135W Laptop Charger AC Adapter (20V 6.75A) - Slim Tip - ADL135NLC2A", priceText: "CA$25", searchedAs: ["cpu"], label: notComponent("an accessory, not a component") },
  { title: "Alienware AW768", priceText: "CA$40", searchedAs: ["cpu"], label: notComponent("a peripheral") },
  { title: "InWin A3 PC Case", priceText: "CA$70", searchedAs: ["cpu"], label: uncatalogued("case") },
  { title: "Mechanical keyboard", priceText: "CA$25", searchedAs: ["cpu"], label: notComponent("a peripheral") },
  { title: "Assorted DDR SDRAM", priceText: "CA$20", searchedAs: ["cpu"], label: notComponent("more than one item") },
  { title: "AMD Ryzen 7 9700x CPU", priceText: "CA$299", searchedAs: ["cpu"], label: component("cpu", "Ryzen 7 9700X") },
  { title: "Thermalright Frozen Notte 240mm ARGB AIO Cooler – Mint", priceText: "CA$55", searchedAs: ["cpu"], label: uncatalogued("cpu_cooler") },
  { title: "Lenovo Yoga 7i 16 2in1 16gb Memory 512gb SSD Laptop *FIRM PRICE*", priceText: "CA$700", searchedAs: ["cpu", "gpu", "storage"], label: notComponent("a whole machine") },
  { title: "Lenovo ThinkPad L15 G2 Touchscreen 8gb Memory 256gb SSD Laptop *FIRM PRICE*", priceText: "CA$400", searchedAs: ["cpu", "storage"], label: notComponent("a whole machine") },
  { title: "MPC CLIENTPRO 375 BTX RETRO P4 GRAY TOWER EM64T XP USA", priceText: "CA$250", searchedAs: ["cpu"], label: notComponent("a whole machine") },
  { title: "Apple MacBook Air M1 16GB RAM 512GB SSD Laptop", priceText: "CA$750", searchedAs: ["cpu", "storage"], label: notComponent("a whole machine") },
  { title: "2025 Gaming PC With 27\" Curved Monitor", priceText: "CA$1,500", searchedAs: ["cpu", "psu"], label: notComponent("a whole machine") },
  { title: "AMD Ryzen 7 9700X 8 Core / 16 Thread Gaming CPU", priceText: "CA$250", searchedAs: ["cpu"], label: component("cpu", "Ryzen 7 9700X") },
  { title: "Budget 1080p Gaming PC – i7-6700 / GTX 1650 Super / 16GB RAM / NVMe SSD (Plug & Play)", priceText: "CA$335", searchedAs: ["cpu", "psu", "ram", "storage"], label: notComponent("a whole machine") },
  { title: "Gaming PC i9 RTX 3070 16gb RAM", priceText: "CA$950", searchedAs: ["cpu", "gpu", "motherboard", "ram", "storage"], label: notComponent("a whole machine") },
  { title: "Mid tier gaming pc", priceText: "CA$1,700", searchedAs: ["cpu", "psu"], label: notComponent("a whole machine") },
  { title: "PC offer good deal", priceText: "CA$300", searchedAs: ["cpu", "motherboard", "psu", "ram"], label: notComponent("a whole machine") },
  { title: "Gaming PC — Intel i7-7700, RTX 3050, 16GB RAM, SSD + 1TB HDD — $550", priceText: "CA$550", searchedAs: ["cpu", "gpu", "motherboard", "storage"], label: notComponent("a whole machine") },
  { title: "5-Bay Hard Drive Station", priceText: "CA$15", searchedAs: ["cpu", "gpu", "motherboard", "ram", "storage"], label: notComponent("an accessory, not a component") },
  { title: "Gaming PC RTX 2080 8GB | Intel i7 | 32GB RAM | 500GB SSD", priceText: "CA$699", searchedAs: ["cpu", "gpu", "motherboard", "storage"], label: notComponent("a whole machine") },
  { title: "Auto Sight T2 Mini Dash Cam", priceText: "CA$50", searchedAs: ["cpu"], label: notComponent("not a PC item") },
  { title: "Dell Precision 5560 Workstation Laptop | i7-11800H | 16GB RAM | 512GB SSD | NVIDIA T1200", priceText: "CA$638", searchedAs: ["cpu", "ram", "storage"], label: notComponent("a whole machine") },
  { title: "Macbook air m5 13 inch", priceText: "CA$1,500", searchedAs: ["cpu"], label: notComponent("a whole machine") },
  { title: "AMD Ryzen Processor  3 3200g", priceText: "CA$80", searchedAs: ["cpu"], label: uncatalogued("cpu") },
  { title: "RTX 4060 | i5-12600KF Custom Gaming PC", priceText: "CA$1,200", searchedAs: ["cpu", "gpu", "motherboard"], label: notComponent("a whole machine") },
  { title: "Intel i7-6700 + motherboard H110", priceText: "CA$150", searchedAs: ["cpu", "motherboard", "ram"], label: notComponent("a bundle of parts") },
  { title: "ASUS Vivobook 16X Laptop - Ryzen 5 5600H, 8GB RAM, 16\" WUXGA, Windows 11", priceText: "CA$400", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Brand New Lenovo IdeaPad 5 2-in-1 – Ryzen 7 8845HS / 16GB RAM / Touchscreen", priceText: "CA$900", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Brand New Lenovo ThinkPad L13 – Ryzen 7 PRO / 16GB RAM / 1TB SSD / Touchscreen", priceText: "CA$850", searchedAs: ["gpu", "ram", "storage"], label: notComponent("a whole machine") },
  { title: "Dell 15.6” Laptop: AMD Ryzen 5, 16GB, 256GB SSD+1TB HDD, Wifi, BT, HDMI, 1080p, Win 11, Office 365", priceText: "CA$250", searchedAs: ["gpu", "storage"], label: notComponent("a whole machine") },
  { title: "🔥 Lenovo ThinkPad T14 Gen 1– Ryzen 5 Pro | 16GB RAM | 256GB SSD 🔥", priceText: "CA$340", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "🚀 ARGB Gaming PC – Intel i5 | RX 570 4GB | 16GB RAM | New Case & SSD", priceText: "CA$350", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "CHEAP GAMING LAPTOP", priceText: "CA$250", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Lenovo Legion Go 2 Handheld Gaming PC – Excellent Condition", priceText: "CA$1,900", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Looking for budget pc around $200", priceText: "CA$0", searchedAs: ["cpu", "gpu"], label: notComponent("a wanted ad") },
  { title: "AMD RX 580 8G GDDR5 Graphics Card", priceText: "CA$150", searchedAs: ["gpu"], label: uncatalogued("gpu") },
  { title: "Samsung 8GB (2x4GB) PC3L-12800S DDR3L 1600MHz Laptop & AIO", priceText: "CA$20", searchedAs: ["gpu"], label: notComponent("laptop memory, not a desktop part") },
  { title: "Laptop Lenovo V15 G4 ABP", priceText: "CA$1,200", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Gaming PC", priceText: "CA$550", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "ASUS RTX 5070 Ti Prime OC 16G(see description)", priceText: "CA$1,949", searchedAs: ["cpu", "gpu"], label: component("gpu", "GeForce RTX 5070 Ti") },
  { title: "Budget Gaming PC RX 5700 XT Ryzen 5 3600XT 16GB RAM", priceText: "CA$350", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "HP Laptop 15s-eq1xxx", priceText: "CA$500", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "17\" RTX Wheels with 215/45R17 Tires", priceText: "CA$300", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "GIGABYTE EAGLE RTX 5070 12GB VRAM", priceText: "CA$1,199", searchedAs: ["gpu"], label: component("gpu", "GeForce RTX 5070") },
  { title: "Dell Inspiron 16 7610 (2021) i7-11800H 16GB 512GB RTX 3060 Dark Grey Fair", priceText: "CA$850", searchedAs: ["gpu", "storage"], label: notComponent("a whole machine") },
  { title: "RTX 5070 Ti - MSI Ventus 3X OC", priceText: "CA$1,800", searchedAs: ["gpu"], label: component("gpu", "GeForce RTX 5070 Ti") },
  { title: "Gigabyte GeForce RTX 1650 4GB", priceText: "CA$60", searchedAs: ["gpu"], label: component("gpu", "GeForce GTX 1650") },
  { title: "ASUS ROG Strix G16 Gaming Laptop | RTX 4050 | i7 13th Gen | 32GB RAM with SAMSUNG 990 2TB SSD", priceText: "CA$1,850", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Gigabyte GeForce RTX 5060 Windforce Max OC 8GB", priceText: "CA$630", searchedAs: ["gpu"], label: component("gpu", "GeForce RTX 5060") },
  { title: "4k Gaming PC | ASUS RTX 3070 OC | Ryzen 7 | 32GB RAM | Lian Li Case", priceText: "CA$1,350", searchedAs: ["gpu", "ram"], label: notComponent("a whole machine") },
  { title: "Gaming PC – Ryzen 7 9800X3D / RTX 5080 16GB", priceText: "CA$4,800", searchedAs: ["gpu", "motherboard"], label: notComponent("a whole machine") },
  { title: "Gaming PC – i7-13700K / RTX 4070 Ti / 32GB DDR5", priceText: "CA$2,800", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "20” RTX Rims with Tires – Set of 4", priceText: "CA$750", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "Zotac Gaming RTX 3080 Trinity OC 10Gb", priceText: "CA$690", searchedAs: ["gpu"], label: component("gpu", "GeForce RTX 3080") },
  { title: "Acer Predator Orion 3000 Gaming PC – i7 / RTX 3070 / 2TB SSD + 2TB HDD", priceText: "CA$1,000", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "HP Victus Gaming Laptop – Ryzen 5 – RTX Graphics – 144Hz", priceText: "CA$750", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Vintage Spiral Direct Grim Reaper Cards Streetwear Graphic Long Sleeve T-Shirt Black Mens", priceText: "CA$25", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "Lenovo IdeaPad 5 (15.6\" Full HD, 12th gen i7, 16GB RAM, 512GB SSD, Nvidia GPU)", priceText: "CA$580", searchedAs: ["gpu", "ram", "storage"], label: notComponent("a whole machine") },
  { title: "1050TI GPU", priceText: "CA$90", searchedAs: ["gpu"], label: component("gpu", "GeForce GTX 1050 Ti") },
  { title: "Msi gtx 1030 2GB Low profile graphic card", priceText: "CA$40", searchedAs: ["gpu"], label: uncatalogued("gpu") },
  { title: "Custom 3D Printed Business Cards", priceText: "CA$2", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "MSI Aegis 3060 i7 desktop pc", priceText: "CA$900", searchedAs: ["gpu", "motherboard"], label: notComponent("a whole machine") },
  { title: "Apple MacBook Air 13\" (2017) – Intel i5 / 8GB RAM / 128GB SSD + Original Box", priceText: "CA$285", searchedAs: ["gpu"], label: notComponent("a whole machine") },
  { title: "Vintage Coca-Cola Collectibles Set", priceText: "CA$20", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "Shaquille O'Neal Fleer All-Star Weekend and SkyBox Metal On The Move Basketball\n$12 for both\n803", priceText: "CA$1", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "2026 Topps Holiday Jacob Misiorowski Rookie Card Red", priceText: "CA$10", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "2026 Topps Holiday Roman Anthony RC #H170 candy cane bat sp", priceText: "CA$10", searchedAs: ["gpu"], label: notComponent("not a PC item") },
  { title: "BROKEN B550-I Gaming Motherboard", priceText: "CA$50", searchedAs: ["motherboard"], label: notComponent("broken") },
  { title: "MSI PRO Z790-A MAX WIFI MOTHERBOARD", priceText: "CA$200", searchedAs: ["motherboard"], label: uncatalogued("motherboard") },
  { title: "Intel I7 3770K, Asus Sabertooth Z77 motherboard, 4x4GB (16GB) Mushkin Redline DDR3 Ram", priceText: "CA$100", searchedAs: ["motherboard"], label: notComponent("a bundle of parts") },
  { title: "Gaming PC (no storage/GPU)", priceText: "CA$170", searchedAs: ["motherboard", "ram"], label: notComponent("a whole machine") },
  { title: "ASUS PRIME Z270-A ATX Motherboard – New, Never Used, Open Box", priceText: "CA$125", searchedAs: ["motherboard"], label: uncatalogued("motherboard") },
  { title: "2 x 4U Rackmount Server Chassis - 16 Bay and 24 Bay Enclosures", priceText: "CA$850", searchedAs: ["motherboard"], label: notComponent("more than one item") },
  { title: "RTX 2080 Super Pc | Ryzen 5 3600 | 16gb DDR4 RAM | 500gb ssd | Wifi 5 + BT", priceText: "CA$875", searchedAs: ["motherboard", "ram"], label: notComponent("a whole machine") },
  { title: "• HP Intel 7260 Dual-Band Wi-Fi & Bluetooth PCIe x1 Desktop Card Kit (F2P07AA) — Complete in Box", priceText: "CA$30", searchedAs: ["motherboard"], label: notComponent("a PC part outside the nine types") },
  { title: "Creality Ender-3 V2 3D Printer", priceText: "CA$200", searchedAs: ["motherboard"], label: notComponent("not a PC item") },
  { title: "Patriots Burst - 120GB SSD", priceText: "CA$30", searchedAs: ["motherboard"], label: uncatalogued("storage") },
  { title: "Corsair RM850 Gold Power Supply (White)", priceText: "CA$80", searchedAs: ["psu"], label: uncatalogued("psu") },
  { title: "uPowerTek LED Driver BLD-096-V024-DNU", priceText: "CA$50", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Red Clip-On Spotlight with Barn Doors", priceText: "CA$15", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "DEWALT DC012 Work Site Charger / Radio - NO BATTERY", priceText: "CA$85", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "32Inch TV & Complete Wii With Extras", priceText: "CA$250", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "32” Flat FHD Monitor with 75Hz Refresh Rate", priceText: "CA$150", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Boss DR-5 Dr. Rhythm Section Drum Machine", priceText: "CA$240", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Radiodetection RD433HCTx-2 Multi-Frequency Transmitter & Radiodetection Locator Receiver Kit", priceText: "CA$1,750", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Line 6 POD X3 Guitar Effects Processor", priceText: "CA$215", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Roland TR-505 Rhythm Composer Drum Machine", priceText: "CA$370", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Rational SCC WE 62 Full Size Electric Combi Oven- Mint Condition", priceText: "CA$7,699", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Reef Aquarium Lights Lot - ATI, AquaticLife, ReefBrite LED", priceText: "CA$80", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Radiodetection RD4000 Cable & Pipe Locator Kit with RD4000T3 3W Transmitter", priceText: "CA$2,600", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Panasonic SlimLine Cassette Recorder", priceText: "CA$39", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Creality Ender-3 3D Printer", priceText: "CA$100", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Simagic Alpha Mini Wheel Base and GTS Leather Steering Wheel", priceText: "CA$625", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Ecler HAK 360 Performance Mixing Instrument DJ mixer", priceText: "CA$700", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Microsoft Surface Pro 11th Edition – Snapdragon X Elite – 16GB RAM – 512GB SSD", priceText: "CA$2,100", searchedAs: ["psu", "storage"], label: notComponent("a whole device that is not a PC part") },
  { title: "Acer Spin 3 Touchscreen Laptop/tablet", priceText: "CA$200", searchedAs: ["ram"], label: notComponent("a whole machine") },
  { title: "Refurbished/Upgraded Lenovo ThinkPad T470", priceText: "CA$189", searchedAs: ["ram"], label: notComponent("a whole machine") },
  { title: "Acer Aspire 3 (A315-59) 15.6\" Laptop – Intel Core i3-1215U, 8GB RAM, [256GB / 512GB] SSD – Like New", priceText: "CA$350", searchedAs: ["ram", "storage"], label: notComponent("a whole machine") },
  { title: "16 GB DDR4 RAM i7 9700 k 250$", priceText: "CA$250", searchedAs: ["ram"], label: notComponent("a bundle of parts") },
  { title: "RAM 8GB DDR4 3200", priceText: "CA$40", searchedAs: ["ram"], label: uncatalogued("ram") },
  { title: "HP ProDesk Mini PC 7th Gen", priceText: "CA$175", searchedAs: ["ram"], label: notComponent("a whole machine") },
  { title: "Dell Inspiron 13-5378 Laptop (Touch)", priceText: "CA$200", searchedAs: ["ram"], label: notComponent("a whole machine") },
  { title: "Dell OptiPlex 7050 desktop - i7processor/16gb ram/256gb ssd/windows11", priceText: "CA$250", searchedAs: ["ram"], label: notComponent("a whole machine") },
  { title: "XPG ADATA", priceText: "CA$120", searchedAs: ["ram"], label: notComponent("the title does not say what it is") },
  { title: "Lenovo Laptop – Intel Core i5 11th Gen | 8GB RAM | SSD", priceText: "CA$399", searchedAs: ["storage"], label: notComponent("a whole machine") },
  { title: "MP33 PRO 1TB SSD", priceText: "CA$250", searchedAs: ["storage"], label: uncatalogued("storage") },
  { title: "Crucial 2tb ssd - PS5 Comptaible Like New", priceText: "CA$380", searchedAs: ["storage"], label: uncatalogued("storage") },
  { title: "Brand New Lenovo Laptop – Intel Core i7 13th Gen / 16GB RAM / 512GB SSD", priceText: "CA$750", searchedAs: ["storage"], label: notComponent("a whole machine") },
  { title: "Samsung Galaxy Book Touchscreen Laptop i7 – 16GB RAM – 512GB", priceText: "CA$420", searchedAs: ["storage"], label: notComponent("a whole machine") },
  { title: "WD 1TB NVME 100% SSD", priceText: "CA$150", searchedAs: ["storage"], label: uncatalogued("storage") },
  { title: "Kioxia 1TB SSD – Removed from MSI Claw 8 AI+", priceText: "CA$170", searchedAs: ["storage"], label: uncatalogued("storage") },
  { title: "Brand new sealed Macbook Pro M5 Max 36GB RAM, 2TB SSD", priceText: "CA$5,300", searchedAs: ["storage"], label: notComponent("a whole machine") },
  { title: "Ddr4 32gb", priceText: "CA$190", searchedAs: ["cpu", "gpu", "motherboard", "psu", "storage"], label: uncatalogued("ram") },
  { title: "Compact Mini-ITX Gaming PC — Ryzen 7 3700X + RX 5700 XT, 32GB RAM | $850 OBO", priceText: "CA$850", searchedAs: ["cpu", "gpu", "ram"], label: notComponent("a whole machine") },
  { title: "PS5 Pro", priceText: "CA$1,600", searchedAs: ["cpu", "storage"], label: notComponent("a whole device that is not a PC part") },
  { title: "Gigabyte RX 7600 Gaming OC GPU", priceText: "CA$500", searchedAs: ["gpu"], label: uncatalogued("gpu") },
  { title: "Gigabyte RTX4060 8GB", priceText: "CA$350", searchedAs: ["gpu"], label: component("gpu", "GeForce RTX 4060") },
  { title: "Share Aqara Roller Shade Driver E1 Zigbee Smart home Curtain APP Control x 3", priceText: "CA$250", searchedAs: ["psu"], label: notComponent("not a PC item") },
  { title: "Logitech g29", priceText: "CA$220", searchedAs: ["psu"], label: notComponent("a peripheral") },
  { title: "EVGA SuperNOVA 850 G5 850W 80+ Gold Fully Modular Power Supply", priceText: "CA$140", searchedAs: ["psu"], label: component("psu", "EVGA SuperNOVA 850 G5") },
  { title: "Corsair MP600LPX PRO 1TB GEN4 M.2 NVMe PCIe SSD - PS5", priceText: "CA$400", searchedAs: ["storage"], label: uncatalogued("storage") },
];
