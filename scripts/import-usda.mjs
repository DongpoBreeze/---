#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import JSZip from 'jszip';

const SOURCE_URL = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip';
const DATASET = 'SR Legacy 2018-04';
const DEFAULT_ARCHIVE = path.resolve('artifacts/usda/FoodData_Central_sr_legacy_food_json_2018-04.zip');
const DEFAULT_OUTPUT = path.resolve('data/nutrition/usda-sr-legacy.json');
const NUTRIENTS = { calories: [1008, 'kcal'], protein: [1003, 'g'], carbs: [1005, 'g'], fat: [1004, 'g'] };

// The manifest is intentionally explicit: descriptions and preparation labels prevent a raw/cooked match from drifting.
// EXTENDED_MANIFEST adds common ingredients while retaining archive-derived identities and Chinese aliases.
const LEGACY_MANIFEST = [
  ['rice_white_long_grain_cooked', '熟白米饭', '168878', '熟制（煮，长粒，强化）'],
  ['potato_boiled_without_salt', '煮土豆（无盐）', '170440', '熟制（煮去皮，无盐）'],
  ['lotus_root_raw', '藕（生）', '169250', '生食'],
  ['lotus_root_boiled', '藕（煮熟）', '168430', '熟制（煮，沥干，无盐）'],
  ['mushroom_white_cooked', '白蘑菇（煮熟）', '168537', '熟制（煮，沥干，加盐）'],
  ['mushroom_enoki_raw', '金针菇（生）', '169382', '生食'],
  ['mushroom_shiitake_raw', '香菇（生）', '169242', '生食'],
  ['tofu_firm', '豆腐（硬，钙盐制）', '172448', '即食/制备食品'],
  ['tofu_soft', '豆腐（软，钙盐制）', '172449', '即食/制备食品'],
  ['tofu_fried', '炸豆腐', '172451', '熟制（油炸）'],
  ['tofu_raw_firm', '豆腐（生，硬）', '172475', '生/未进一步烹调'],
  ['soybean_oil', '大豆油', '171411', '食用油（沙拉或烹调）'],
  ['soy_sauce', '酱油（黄豆和小麦制）', '174277', '调味品'],
  ['egg_raw', '鸡蛋（生）', '171287', '生食'],
  ['egg_hard_boiled', '鸡蛋（煮熟）', '173424', '熟制（煮，全熟）'],
  ['chicken_breast_raw', '鸡肉（生，去皮去骨肉）', '171052', '生食'],
  ['chicken_roasted', '鸡肉（烤熟，去皮去骨肉）', '171054', '熟制（烤）'],
  ['carrot_raw', '胡萝卜（生）', '170393', '生食'],
  ['carrot_boiled', '胡萝卜（煮熟）', '169339', '熟制（煮，沥干，加盐）'],
  ['onion_raw', '洋葱（生）', '170000', '生食'],
  ['onion_boiled', '洋葱（煮熟）', '170001', '熟制（煮，沥干，无盐）'],
  ['broccoli_raw', '西兰花（生）', '170379', '生食'],
  ['broccoli_boiled', '西兰花（煮熟）', '169967', '熟制（煮，沥干，无盐）'],
  ['spinach_cooked', '菠菜（煮熟）', '168463', '熟制（煮，沥干，无盐）'],
  ['cabbage_raw', '卷心菜（生）', '169975', '生食'],
  ['cabbage_boiled', '卷心菜（煮熟）', '169976', '熟制（煮，沥干，无盐）'],
  ['soba_cooked', '荞麦面（熟）', '168907', '熟制'],
  ['rice_noodles_cooked', '米粉（熟）', '168914', '熟制'],
  ['egg_noodles_cooked', '鸡蛋面（熟）', '168919', '熟制（加盐，强化）'],
];

// Extended rows are explicitly selected from the same archive to keep the mobile catalog
// useful while preserving raw/cooked and salt/preparation distinctions.
const EXTENDED_MANIFEST = [
  ["rice_white_long_grain_raw","生白米（长粒）","168877","生/未烹调（长粒，强化）",["生米","长粒白米"]],
  ["rice_white_medium_grain_raw","生白米（中粒）","168879","生/未烹调（中粒，强化）",["中粒生米","中粒白米"]],
  ["rice_white_medium_grain_cooked","熟白米饭（中粒）","168880","熟制（煮，中粒，强化）",["中粒米饭","熟中粒白米"]],
  ["rice_white_short_grain_raw","生白米（短粒）","168881","生/未烹调（短粒，强化）",["短粒生米","短粒白米"]],
  ["rice_white_short_grain_cooked","熟白米饭（短粒）","168882","熟制（煮，短粒，强化）",["短粒米饭","熟短粒白米"]],
  ["rice_brown_long_grain_raw","糙米（长粒，生）","169703","生/未烹调（长粒）",["生糙米","长粒糙米"]],
  ["rice_brown_long_grain_cooked","糙米饭（长粒，熟）","169704","熟制（煮，长粒）",["熟糙米","糙米饭"]],
  ["quinoa_raw","藜麦（生）","168874","生/未烹调",["生藜麦"]],
  ["quinoa_cooked","藜麦（熟）","168917","熟制（煮）",["熟藜麦","藜麦饭"]],
  ["oats_dry","燕麦片（干）","173904","生/干燥（未强化）",["干燕麦","燕麦"]],
  ["oats_cooked","燕麦粥（熟）","173905","熟制（水煮，无盐）",["熟燕麦","燕麦粥"]],
  ["barley_cooked","大麦（熟）","170285","熟制（煮）",["熟大麦"]],
  ["bulgur_cooked","碎麦（熟）","170287","熟制（煮）",["熟碎麦","布格麦"]],
  ["pasta_cooked","意大利面（熟）","169737","熟制（强化，无盐）",["熟面条","通心粉"]],
  ["pasta_whole_wheat_cooked","全麦意大利面（熟）","168910","熟制（全麦）",["全麦面条","熟全麦意面"]],
  ["somen_cooked","素面（熟）","168909","熟制",["日式细面","熟素面"]],
  ["bread_whole_wheat","全麦面包","172688","即食/制备食品",["全麦吐司","全麦面包片"]],
  ["bread_pita_whole_wheat","全麦皮塔饼","174916","即食/制备食品",["全麦口袋饼","皮塔饼"]],
  ["potato_raw_with_skin","土豆（生，带皮）","170032","生食（带皮）",["生土豆","马铃薯"]],
  ["potato_baked","土豆（烤熟，带皮带肉）","170093","熟制（烘烤，无盐）",["烤土豆","烤马铃薯"]],
  ["sweet_potato_raw","红薯（生）","168482","生食",["生红薯","生地瓜"]],
  ["sweet_potato_baked","红薯（烤熟）","168483","熟制（带皮烘烤，无盐）",["烤红薯","烤地瓜"]],
  ["sweet_potato_boiled","红薯（煮熟）","168484","熟制（去皮水煮）",["煮红薯","煮地瓜"]],
  ["taro_raw","芋头（生）","169308","生食",["生芋头"]],
  ["taro_cooked","芋头（熟）","168486","熟制（无盐）",["熟芋头","煮芋头"]],
  ["yam_raw","山药（生）","170071","生食",["生山药"]],
  ["yam_cooked","山药（熟）","170072","熟制（煮、蒸或烘烤，无盐）",["熟山药","蒸山药"]],
  ["cassava_raw","木薯（生）","169985","生食",["生木薯"]],
  ["asparagus_raw","芦笋（生）","168389","生食",["生芦笋"]],
  ["kale_raw","羽衣甘蓝（生）","168421","生食",["羽衣甘蓝","生羽衣甘蓝"]],
  ["spinach_raw","菠菜（生）","168462","生食",["生菠菜"]],
  ["cauliflower_raw","菜花（生）","169986","生食",["生花菜","生菜花"]],
  ["cauliflower_boiled","菜花（煮熟）","170397","熟制（水煮，沥干，无盐）",["煮菜花","熟花菜"]],
  ["tomato_raw","番茄（生）","170457","生食",["西红柿","生番茄"]],
  ["cucumber_raw","黄瓜（生，带皮）","168409","生食（带皮）",["生黄瓜","带皮黄瓜"]],
  ["cucumber_peeled_raw","黄瓜（生，去皮）","169225","生食（去皮）",["去皮黄瓜"]],
  ["lettuce_green_leaf_raw","生菜（绿叶）","169249","生食",["绿叶生菜","生菜"]],
  ["lettuce_iceberg_raw","球生菜（生）","169248","生食",["冰山生菜","结球莴苣"]],
  ["pepper_red_raw","红甜椒（生）","170108","生食",["红彩椒","红椒"]],
  ["pepper_green_raw","青甜椒（生）","170427","生食",["青椒","青彩椒"]],
  ["zucchini_raw","西葫芦（生）","169291","生食",["角瓜","生西葫芦"]],
  ["green_beans_raw","四季豆（生）","169961","生食",["豆角","菜豆"]],
  ["green_beans_boiled","四季豆（煮熟）","169141","熟制（水煮，沥干，无盐）",["煮豆角","熟四季豆"]],
  ["peas_green_boiled","青豌豆（煮熟）","170420","熟制（水煮，沥干，无盐）",["豌豆","煮豌豆"]],
  ["corn_yellow_boiled","玉米粒（煮熟）","169999","熟制（水煮，沥干，无盐）",["熟玉米","玉米粒"]],
  ["eggplant_raw","茄子（生）","169228","生食",["生茄子"]],
  ["celery_raw","芹菜（生）","169988","生食",["生芹菜"]],
  ["garlic_raw","大蒜（生）","169230","生食",["蒜","生蒜"]],
  ["ginger_raw","姜（生）","169231","生食",["生姜","姜"]],
  ["mushroom_white_raw","白蘑菇（生）","169251","生食",["口蘑","生白蘑菇"]],
  ["apple_raw_skin","苹果（生，带皮）","171688","生食（带皮）",["生苹果","带皮苹果"]],
  ["apple_raw_no_skin","苹果（生，去皮）","171689","生食（去皮）",["去皮苹果"]],
  ["banana_raw","香蕉（生）","173944","生食",["生香蕉"]],
  ["orange_raw","橙子（生）","169097","生食",["橙","鲜橙"]],
  ["strawberry_raw","草莓（生）","167762","生食",["生草莓"]],
  ["blueberry_raw","蓝莓（生）","171711","生食",["生蓝莓"]],
  ["grape_raw","葡萄（生）","174683","生食",["生葡萄"]],
  ["pear_raw","梨（生）","169118","生食",["生梨"]],
  ["avocado_raw","牛油果（生）","171705","生食",["鳄梨","生鳄梨"]],
  ["kiwi_raw","猕猴桃（生）","168153","生食",["奇异果","生猕猴桃"]],
  ["mango_raw","芒果（生）","169910","生食",["生芒果"]],
  ["peach_raw","桃（生）","169928","生食",["生桃"]],
  ["pineapple_raw","菠萝（生）","169124","生食",["凤梨","生菠萝"]],
  ["watermelon_raw","西瓜（生）","167765","生食",["生西瓜"]],
  ["cherry_raw","樱桃（生）","171719","生食",["车厘子","生樱桃"]],
  ["lemon_raw","柠檬（生，去皮）","167746","生食（去皮）",["生柠檬"]],
  ["lime_raw","青柠（生）","168155","生食",["酸橙","青柠檬"]],
  ["chicken_thigh_raw","鸡腿肉（生，带皮）","172385","生食（带皮）",["生鸡腿","鸡腿"]],
  ["chicken_thigh_roasted","鸡腿肉（烤熟，带皮）","173625","熟制（烘烤，带皮）",["烤鸡腿","熟鸡腿"]],
  ["turkey_breast_raw","火鸡胸肉（生）","171098","生食",["生火鸡胸"]],
  ["turkey_breast_roasted","火鸡胸肉（烤熟）","171496","熟制（烘烤）",["烤火鸡胸","熟火鸡胸"]],
  ["pork_tenderloin_raw","猪里脊（生）","168312","生食",["生猪里脊","猪里脊肉"]],
  ["pork_tenderloin_roasted","猪里脊（烤熟）","167905","熟制（烘烤）",["烤猪里脊","熟猪里脊"]],
  ["bacon_raw","培根（生）","168277","生/未进一步烹调",["生培根"]],
  ["bacon_baked","培根（烤熟）","167914","熟制（烘烤）",["熟培根","烤培根"]],
  ["beef_ground_85_raw","牛绞肉（85%瘦肉，生）","171796","生食",["生牛肉馅","85%瘦牛绞肉"]],
  ["beef_ground_85_cooked","牛绞肉（85%瘦肉，煎熟）","174032","熟制（煎烤）",["熟牛肉馅","煎牛肉末"]],
  ["salmon_farmed_raw","养殖大西洋三文鱼（生）","175167","生食",["生三文鱼","生鲑鱼"]],
  ["salmon_farmed_cooked","养殖大西洋三文鱼（熟）","175168","熟制（干热烹调）",["熟三文鱼","烤三文鱼"]],
  ["cod_atlantic_raw","大西洋鳕鱼（生）","171955","生食",["生鳕鱼"]],
  ["cod_atlantic_cooked","大西洋鳕鱼（熟）","171956","熟制（干热烹调）",["熟鳕鱼","烤鳕鱼"]],
  ["tilapia_raw","罗非鱼（生）","175176","生食",["生罗非鱼"]],
  ["tilapia_cooked","罗非鱼（熟）","175177","熟制（干热烹调）",["熟罗非鱼"]],
  ["tuna_yellowfin_raw","黄鳍金枪鱼（生）","175159","生食",["生金枪鱼","黄鳍鱼"]],
  ["shrimp_raw","虾（生）","174210","生食",["生虾","鲜虾"]],
  ["shrimp_cooked","虾（熟，湿热）","171971","熟制（湿热）",["熟虾","水煮虾"]],
  ["edamame_frozen_raw","毛豆（冷冻，未烹调）","168410","冷冻未烹调",["冷冻毛豆","枝豆"]],
  ["edamame_frozen_cooked","毛豆（冷冻，熟）","168411","熟制（冷冻后烹调）",["熟毛豆","熟枝豆"]],
  ["lentils_raw","扁豆（生）","172420","生/干燥",["干扁豆","生扁豆"]],
  ["lentils_cooked","扁豆（煮熟）","172421","熟制（水煮，无盐）",["煮扁豆","熟扁豆"]],
  ["black_beans_raw","黑豆（生）","173734","生/干燥",["生黑豆","干黑豆"]],
  ["black_beans_cooked","黑豆（煮熟）","173735","熟制（水煮，无盐）",["煮黑豆","熟黑豆"]],
  ["chickpeas_raw","鹰嘴豆（生）","173756","生/干燥",["生鹰嘴豆","干鹰嘴豆"]],
  ["chickpeas_cooked","鹰嘴豆（煮熟）","173757","熟制（水煮，无盐）",["煮鹰嘴豆","熟鹰嘴豆"]],
  ["kidney_beans_raw","芸豆（生）","175193","生/干燥",["生芸豆","干芸豆"]],
  ["kidney_beans_cooked","芸豆（煮熟）","173740","熟制（水煮，无盐）",["煮芸豆","熟芸豆"]],
  ["split_peas_cooked","豌豆（干，煮熟）","172429","熟制（水煮，无盐）",["煮干豌豆","熟豌豆"]],
  ["tofu_dried","高野豆腐（干）","174303","制备食品（干燥冻豆腐）",["高野豆腐","干高野豆腐"]],
  ["milk_whole","全脂牛奶","172217","即食/制备食品（3.25%乳脂）",["全脂奶","牛奶"]],
  ["milk_lowfat","低脂牛奶（1%）","170872","即食/制备食品（1%乳脂，强化）",["低脂奶","1%牛奶"]],
  ["milk_skim","脱脂牛奶","173432","即食/制备食品（脱脂）",["脱脂奶","无脂牛奶"]],
  ["yogurt_plain_whole","原味全脂酸奶","171284","即食/制备食品",["全脂酸奶","原味酸奶"]],
  ["yogurt_plain_lowfat","原味低脂酸奶","170886","即食/制备食品",["低脂酸奶","原味低脂酸奶"]],
  ["yogurt_greek_nonfat","原味脱脂希腊酸奶","170894","即食/制备食品",["希腊酸奶","脱脂希腊酸奶"]],
  ["cottage_cheese_lowfat","低脂茅屋奶酪","173417","即食/制备食品（1%乳脂）",["低脂乡村奶酪","茅屋奶酪"]],
  ["cheddar_cheese","切达奶酪","173414","即食/制备食品",["切达芝士","切达奶酪"]],
  ["olive_oil","橄榄油","171413","食用油（沙拉或烹调）",["橄榄油","食用橄榄油"]],
  ["almonds_raw","杏仁（生）","170567","生食",["生杏仁"]],
  ["chia_seeds_dried","奇亚籽（干）","170554","生/干燥",["奇亚籽","干奇亚籽"]],
  ["peanut_butter","花生酱","174294","即食/制备食品",["花生酱（顺滑）"]],
];

const MANIFEST = [...LEGACY_MANIFEST, ...EXTENDED_MANIFEST];

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function loadArchive(archive) {
  try { return await fs.readFile(archive); } catch (error) {
    if (archive !== DEFAULT_ARCHIVE) throw error;
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`USDA download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, bytes);
    return bytes;
  }
}

function nutrientValue(food, nutrientId, unit) {
  const records = food.foodNutrients.filter((record) => Number(record.nutrient?.id) === nutrientId);
  if (records.length > 1) throw new Error(`duplicate nutrient ${nutrientId} for ${food.fdcId}`);
  if (!records.length) return null;
  const record = records[0];
  if (record.nutrient.unitName !== unit) throw new Error(`unexpected unit for ${food.fdcId}/${nutrientId}: ${record.nutrient.unitName}`);
  return typeof record.amount === 'number' && Number.isFinite(record.amount) ? record.amount : null;
}

function validateManifest() {
  const ids = new Set();
  const fdcIds = new Set();
  const aliases = new Set();
  for (const [id, label, fdcId, preparation, rowAliases] of MANIFEST) {
    if (!/^[a-z0-9_]+$/.test(id) || !label || !/^\d+$/.test(fdcId) || !preparation) throw new Error(`invalid USDA manifest row ${id}`);
    if (ids.has(id)) throw new Error(`duplicate USDA manifest id ${id}`);
    if (fdcIds.has(fdcId)) throw new Error(`duplicate USDA manifest fdcId ${fdcId}`);
    ids.add(id);
    fdcIds.add(fdcId);
    if (rowAliases !== undefined) {
      if (!Array.isArray(rowAliases) || !rowAliases.length || rowAliases.some((alias) => typeof alias !== 'string' || !alias.trim())) throw new Error(`invalid USDA aliases for ${id}`);
      for (const alias of rowAliases) {
        if (aliases.has(alias)) throw new Error(`duplicate USDA alias ${alias}`);
        aliases.add(alias);
      }
    }
  }
}

export async function importUsda({ archive = DEFAULT_ARCHIVE, output = DEFAULT_OUTPUT } = {}) {
  validateManifest();
  const archiveBytes = await loadArchive(archive);
  const archiveSha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex').toUpperCase();
  const zip = await JSZip.loadAsync(archiveBytes);
  const member = Object.values(zip.files).find((entry) => entry.name.endsWith('.json'));
  if (!member) throw new Error('USDA archive has no JSON member');
  const parsed = JSON.parse(await member.async('string'));
  const foods = parsed.SRLegacyFoods;
  if (!Array.isArray(foods)) throw new Error('USDA JSON missing SRLegacyFoods');
  const byId = new Map(foods.map((food) => [String(food.fdcId), food]));
  const selected = MANIFEST.map(([id, label, fdcId, preparation, aliases]) => {
    const food = byId.get(fdcId);
    if (!food) throw new Error(`manifest fdcId ${fdcId} not found`);
    const per100g = {};
    for (const [key, [nutrientId, unit]] of Object.entries(NUTRIENTS)) per100g[key] = nutrientValue(food, nutrientId, unit);
    return { id, label, description: food.description, fdcId, preparation, ...(aliases?.length ? { aliases } : {}), per100g };
  });
  const result = { version: 1, provider: 'usda-fdc', dataset: DATASET, sourceUrl: SOURCE_URL, archiveSha256, license: 'CC0-1.0', foods: selected };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await importUsda({ archive: path.resolve(arg('archive', DEFAULT_ARCHIVE)), output: path.resolve(arg('output', DEFAULT_OUTPUT)) });
  console.log(`Imported ${result.foods.length} USDA foods from ${result.archiveSha256}`);
}

export { LEGACY_MANIFEST, EXTENDED_MANIFEST, MANIFEST, NUTRIENTS, SOURCE_URL };
