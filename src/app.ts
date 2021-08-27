import { createCanvas, loadImage } from "canvas";
import * as fs from "fs";
import pathlib from "path";
import { parallelizeOver, keys } from "./helpers/common";
import { getMultipleIcons } from "./helpers/main";
import { ImageMatrix, Matrix } from "./helpers/matrix";

/**
 *
 * @type {<K extends (number | string | symbol), V>(keys: Iterable<K>, values: Iterable<V>) => Record<K, V>}
 */
function createObject(keys, values) {
	const iter = values[Symbol.iterator]();

	/**
	 * @type {Record<any, any>}
	 */
	const obj = {};
	for (const k of keys) {
		obj[k] = iter.next().value;
	}
	return obj;
}

/**
 * @type {(templateImage: import("canvas").Image) => ((oldmatrix: Matrix, rest: any) => Promise<Matrix>)}
 */
function templateImageFunc(templateImage) {
	return async (oldmatrix, { palette, offset, blend, first = false }) => {
		let matrix = await ImageMatrix.create(templateImage);
		try {
			await matrix.replaceColor(palette);
			if (first) return matrix;
			if (blend === "underlay") {
				matrix.merge(oldmatrix, offset);
				return matrix;
			}
			oldmatrix.merge(matrix, offset);
			return oldmatrix;
		} catch (e) {
			console.log(matrix.replaceColor);
			return oldmatrix;
		}
	};
}

/**
 * @type {Record<string, (oldmatrix: Matrix, rest: any) => Promise<Matrix>>}
 */
const baseActions = {
	async image(oldmatrix, { palette, path, offset, blend, first = false }) {
		const matrix = await ImageMatrix.create(path);
		await matrix.replaceColor(palette);
		if (first) return matrix;
		if (blend === "underlay") {
			matrix.merge(oldmatrix, offset);
			return matrix;
		}
		oldmatrix.merge(matrix, offset);
		return oldmatrix;
	},
	async recolor(matrix, { palette, first = false }) {
		if (first) throw new Error("Recolor can't be the first action in a series");
		await matrix.replaceColor(palette);
		return matrix;
	},
};

/**
 *
 * @param {number} num
 * @param {string} file
 * @param {Record<string, [number, number]>} templates
 * @param {[number, number]} size
 * @param {Record<string, Action[]>} tiers
 * @param {import("canvas").CanvasRenderingContext2D} gctx
 * @returns {Promise<true>}
 */
async function imageexpr(num, file, templates, size, tiers, gctx) {
	const actionMap = {
		...createObject(
			keys(templates),
			(
				await getMultipleIcons(await loadImage(file), [24, 24], Object.values(templates))
			).map((v) => templateImageFunc(v))
		),
		...baseActions,
	};

	await parallelizeOver(keys(tiers), async (tier, i) => {
		const actions = tiers[tier];
		/** @type {Matrix} */
		let matrix = await actionMap[actions[0].type](undefined, {
			first: true,
			...actions[0],
		});
		for (let ii = 0; ii < actions.length; ii++) {
			const element = actions[ii];
			if (!(element.type in actionMap)) {
				console.warn(element.type, " is not in actionMap");
				continue;
			}
			matrix = await actionMap[element.type](matrix, element);
		}

		gctx.putImageData(matrix.getImage(), num * size[0], i * size[1]);
	});
	return true;
}

/**
 * Generate an image based on the provided configuration
 * @param {IConfig} config The options to run Printing Press with
 */
export async function print(config) {
	const {
		options: { size = [1, 1], order = false } = {},
		files: { templates: templateDir = "./templates", out: outDir = "./out" } = {},
		templates = {},
		levels = {},
	} = config;

	let sort;
	if (typeof order === "function") sort = order;
	else if (typeof order === "string") {
		const regex = new RegExp(order);
		sort = (a, b) => {
			const a1 = parseInt(regex.exec(a)[1]);
			const b1 = parseInt(regex.exec(b)[1]);
			if (a1 > b1) return 1;
			if (a1 < b1) return -1;
			return 0;
		};
	}

	// Number of templates
	const images = fs.readdirSync(templateDir).length;
	const canvas = createCanvas(images * 24, Object.keys(levels).length * 24);
	const ctx = canvas.getContext("2d");

	const files = await parallelizeOver(
		fs.readdirSync(templateDir).map((file) => pathlib.join(templateDir, file)),
		async (file) => {
			if (fs.statSync(file).isFile()) return file;
		}
	);

	await parallelizeOver(sort ? files.sort(sort) : files, async (file, i) => {
		return imageexpr(i, file, templates, size, levels, ctx);
	});

	fs.promises.writeFile(pathlib.join(outDir, "./tierlist.png"), canvas.toBuffer(), "binary");

	return config;
}

/**
 * Analyse the provided image
 * @param {string} image The path to the image to analyse
 * @param {{ levels: string[] }} options
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
export async function press(image, { levels }) {
	const main = await loadImage(image);
	const data = (
		await parallelizeOver(
			await getMultipleIcons(
				main,
				[main.width, 24],
				levels.map((_, i) => {
					return [0, i];
				})
			),
			async (src) => ImageMatrix.create(src)
		)
	)
		.map((mtrx) => mtrx.getPalette())
		.map((pallette) => {
			/**
			 * @type {Record<string, string>}
			 */
			const histo = {};
			let sumPX = 0;
			for (const key in pallette)
				if ({}.hasOwnProperty.call(pallette, key)) {
					const colors = pallette[key];
					sumPX += colors.length;
				}

			for (const key in pallette)
				if ({}.hasOwnProperty.call(pallette, key)) {
					const colors = pallette[key];
					const percent = (colors.length / sumPX) * 100;
					if (percent < 1) continue;
					histo[key] = `${percent.toFixed(2)}%`;
				}

			return histo;
		});
	const fixedData = levels.map((tier, i) => {
		return { [tier]: data[i] };
	});

	/**
	 * @type {Record<string, Record<string, string>>}
	 */
	const final = {};
	for (const histo of fixedData) Object.assign(final, histo);

	return final;
}