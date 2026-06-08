// Configuration for the Google Places "discover" sweep (api/laundries/discover).
//
// Anchors: the 30 Madrid search points from the original R script. The endpoint
// is called once per anchor by the frontend (keeps each serverless request
// short and lets the UI show progress); overlapping 2km radii give good
// coverage without pagination.
export const ANCHORS = [
  [40.40249720895843, -3.711397533076377, 'piramides'],
  [40.41861513833227, -3.6228183642870677, 'alsacia'],
  [40.4595748867333, -3.645922948790618, 'esperanza'],
  [40.50824971325536, -3.6694246422656835, 'las tablas'],
  [40.40972234404867, -3.738841055857744, 'alto de extremadura'],
  [40.37187784319242, -3.7518036398411874, 'carabanchel alto'],
  [40.33660669412484, -3.7399180916922745, 'el carrascal'],
  [40.35276972749271, -3.6836586260321855, 'villaverde bajo'],
  [40.40300460457365, -3.6942740416905364, 'palos de la frontera'],
  [40.420248076431825, -3.7057217964495712, 'callao'],
  [40.42702943473095, -3.7136238815625293, 'ventura rodriguez'],
  [40.44682345432421, -3.7187784703176403, 'vicente alexandre'],
  [40.45458206908356, -3.70303215556148, 'estrecho'],
  [40.46673237826348, -3.6892298281102485, 'plaza de castilla'],
  [40.446235436837945, -3.677976989862758, 'cruz del rayo'],
  [40.439432344266336, -3.662947769108604, 'parque de las avenidas'],
  [40.435720692610154, -3.642825967310786, 'pueblo nuevo'],
  [40.42637813420509, -3.6507841505266097, 'la elipa'],
  [40.42244610855786, -3.668868875274999, 'odonnell'],
  [40.411369802433484, -3.66183075905478, 'estrella'],
  [40.404562168011175, -3.6807273423823967, 'menendez pelayo'],
  [40.389802466610135, -3.6455090087746207, 'alto del arenal'],
  [40.321613182410566, -3.864658385027127, 'pradillo'],
  [40.43086930460519, -3.64129032558881, 'ascao'],
  [40.38210381531072, -3.779974702245494, 'las aguilas'],
  [40.37004519960582, -3.6939975141393795, 'san fermin'],
  [40.485275339466625, -3.721338736538543, 'lacoma'],
  [40.48325978179875, -3.6158533496347247, 'valdebebas'],
  [40.37281582719451, -3.617565416427034, 'congosto'],
  [40.25578156087339, -3.8285017116459272, 'humanes'],
];

// One or two keywords per category (legacy Places Nearby Search "keyword").
// Kept tight so each anchor request stays fast (first page only, no pagination).
export const CATEGORIES = {
  lavanderia:  { label: 'Lavandería',   keywords: ['lavandería autoservicio', 'colada'] },
  casa_empeno: { label: 'Casa de empeño', keywords: ['casa de empeño', 'compro oro'] },
  supermercado:{ label: 'Supermercado', keywords: ['supermercado'] },
};

export const RADIUS_M = 2000;
