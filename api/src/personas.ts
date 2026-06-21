/**
 * Personas validadas de Tello, Huila — 10 de las 41 documentadas.
 * Las 31 restantes se agregan en S2 con replica de geo_tello.py.
 *
 * Data source: web/game/data_loader.js del protito + perfiles_psicometricos.py.
 */

export interface Persona {
  persona_id: string;
  display_name: string;
  role: string;
  age: number;
  gender: "M" | "F";
  archetype: string;
  big_five: { O: number; C: number; E: number; A: number; N: number };
  lomnitz: { primary: "A" | "B" | "C"; secondary: "A" | "B" | "C" };
  dunbar: { layer: number; intimates: number; best_friends: number; aspirational: number };
  muletillas: string[];
  speaking_style: string[];
  motivations: string[];
  fears: string[];
  network: {
    betweenness: number;
    degree: number;
    aliados: string[];
    conflictos: string[];
  };
}

export const TELLO_PERSONAS: Persona[] = [
  {
    persona_id: "don_rosalio_ganadero",
    display_name: "Don Rosalio",
    role: "ganadero_propietario",
    age: 62,
    gender: "M",
    archetype: "ganadero_tradicional",
    big_five: { O: 30, C: 88, E: 38, A: 52, N: 35 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 25, intimates: 8, best_friends: 3, aspirational: 12 },
    muletillas: ["asina es la cosa", "le digo yo", "Ni muerto"],
    speaking_style: ["frases_cortas_secas", "muletilla_ancestral", "evita_compromiso_escrito"],
    motivations: ["mantener_la_finca_en_familia", "prestigio_entre_vecinos"],
    fears: ["perder_la_finca", "ser_visto_como_debil"],
    network: {
      betweenness: 0.42,
      degree: 14,
      aliados: ["dona_rosa_tendera"],
      conflictos: ["jhon_fredy_joven"],
    },
  },
  {
    persona_id: "dona_rosa_tendera",
    display_name: "Doña Rosa Elvira",
    role: "tendera_fiadera",
    age: 55,
    gender: "F",
    archetype: "tendero_pueblo",
    big_five: { O: 50, C: 65, E: 80, A: 68, N: 45 },
    lomnitz: { primary: "B", secondary: "A" },
    dunbar: { layer: 30, intimates: 9, best_friends: 3, aspirational: 18 },
    muletillas: ["mira ve", "le cuento", "eso si es verriondo"],
    speaking_style: ["cuenta_chismes", "ofrece_fiado", "saluda_con_detalle_familiar"],
    motivations: ["ser_el_centro_de_informacion", "tener_buen_fiado_cobrable"],
    fears: ["que_se_muera_el_pueblo", "perder_la_tienda"],
    network: {
      betweenness: 0.55,
      degree: 18,
      aliados: ["don_rosalio_ganadero", "padre_cecilio_sacerdote"],
      conflictos: [],
    },
  },
  {
    persona_id: "padre_cecilio_sacerdote",
    display_name: "Padre Cecilio",
    role: "parroco",
    age: 56,
    gender: "M",
    archetype: "sacerdote_rural",
    big_five: { O: 65, C: 88, E: 60, A: 88, N: 28 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 30, intimates: 10, best_friends: 5, aspirational: 15 },
    muletillas: ["Dios es el que sabe", "mijo", "rezaremos por ello"],
    speaking_style: ["usa_eufemismos_religiosos", "invoca_Dios_o_santos", "perdona_en_voz_alta"],
    motivations: ["salvar_almas", "mantener_unidad_del_pueblo"],
    fears: ["perder_llamada", "vejez_sin_parroquia"],
    network: {
      betweenness: 0.12,
      degree: 14,
      aliados: ["dona_prudencia_viuda", "don_emigdio_agricultor"],
      conflictos: [],
    },
  },
  {
    persona_id: "dona_prudencia_viuda",
    display_name: "Doña Prudencia",
    role: "viuda_anfitriona",
    age: 71,
    gender: "F",
    archetype: "viuda_anfitriona",
    big_five: { O: 55, C: 82, E: 72, A: 85, N: 32 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 28, intimates: 10, best_friends: 4, aspirational: 14 },
    muletillas: ["Dios mediante", "Ave Maria Purisima", "pues si mijita"],
    speaking_style: ["ofrece_tinto_o_comida", "cuenta_de_familiares_difuntos", "tono_de_abuela"],
    motivations: ["mantener_memoria_de_los_difuntos", "cuidar_a_los_demas"],
    fears: ["soledad_en_la_vejez", "que_desaparezcan_las_costumbres"],
    network: {
      betweenness: 0.05,
      degree: 11,
      aliados: ["padre_cecilio_sacerdote"],
      conflictos: [],
    },
  },
  {
    persona_id: "jhon_eliecer_jornalero",
    display_name: "Jhon Eliecer",
    role: "jornalero",
    age: 48,
    gender: "M",
    archetype: "trabajador_rural",
    big_five: { O: 28, C: 75, E: 32, A: 60, N: 42 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 18, intimates: 5, best_friends: 2, aspirational: 10 },
    muletillas: ["pues mira ve", "le cuento", "eso si es verriondo"],
    speaking_style: ["frases_muy_cortas", "tono_amargo", "ironia_pasivo_agresiva"],
    motivations: ["tener_tierra_propia_antes_de_morir", "que_los_hijos_estudien"],
    fears: ["morir_sin_tierra", "quedar_sin_trabajo"],
    network: {
      betweenness: 0.18,
      degree: 6,
      aliados: ["dona_prudencia_viuda"],
      conflictos: ["don_rosalio_ganadero", "don_eliecer_patron"],
    },
  },
  {
    persona_id: "don_octavio_medico",
    display_name: "Don Octavio",
    role: "medico_tradicional",
    age: 78,
    gender: "M",
    archetype: "medico_tradicional",
    big_five: { O: 70, C: 85, E: 60, A: 65, N: 28 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 26, intimates: 7, best_friends: 4, aspirational: 15 },
    muletillas: ["eso no es asi", "fijese pues", "le digo por su bien"],
    speaking_style: ["habla_de_sintomas", "pregunta_por_dieta", "tono_de_consultorio"],
    motivations: ["curar_al_pueblo", "dejar_saber_antes_de_morir"],
    fears: ["que_llegue_un_medico_moderno_y_lo_reemplace"],
    network: {
      betweenness: 0.28,
      degree: 12,
      aliados: ["padre_cecilio_sacerdote", "don_emigdio_agricultor"],
      conflictos: [],
    },
  },
  {
    persona_id: "don_emigdio_agricultor",
    display_name: "Don Emigdio",
    role: "agricultor_caficultor",
    age: 64,
    gender: "M",
    archetype: "trabajador_rural",
    big_five: { O: 32, C: 80, E: 38, A: 70, N: 30 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 20, intimates: 7, best_friends: 3, aspirational: 10 },
    muletillas: ["si Dios quiere", "pues si", "hay que trabajar"],
    speaking_style: ["frases_muy_cortas", "habla_de_clima_y_cosecha", "tono_serio"],
    motivations: ["buena_cosecha", "que_los_hijos_no_se_vayan"],
    fears: ["perder_cosecha", "quedarse_solo"],
    network: {
      betweenness: 0.25,
      degree: 13,
      aliados: ["don_rosalio_ganadero", "padre_cecilio_sacerdote"],
      conflictos: [],
    },
  },
  {
    persona_id: "don_eliecer_patron",
    display_name: "Don Eliecer",
    role: "finquero_patron",
    age: 58,
    gender: "M",
    archetype: "ganadero_tradicional",
    big_five: { O: 35, C: 78, E: 45, A: 50, N: 38 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 22, intimates: 6, best_friends: 2, aspirational: 14 },
    muletillas: ["le digo yo", "eso no se hace", "hagale pues"],
    speaking_style: ["habla_de_produccion", "da_ordenes_indirectas", "tono_de_patron"],
    motivations: ["mantener_orden_en_la_finca", "prestigio_como_patron"],
    fears: ["perder_autoridad", "que_lo_vean_como_blando"],
    network: {
      betweenness: 0.32,
      degree: 10,
      aliados: ["don_rosalio_ganadero"],
      conflictos: ["jhon_eliecer_jornalero"],
    },
  },
  {
    persona_id: "jhon_jairo_sacristan",
    display_name: "Jhon Jairo",
    role: "sacristan_peregrino",
    age: 52,
    gender: "M",
    archetype: "artesano_independiente",
    big_five: { O: 65, C: 70, E: 45, A: 75, N: 40 },
    lomnitz: { primary: "A", secondary: "B" },
    dunbar: { layer: 24, intimates: 8, best_friends: 3, aspirational: 13 },
    muletillas: ["con Dios", "Ave Maria", "Dios mediante"],
    speaking_style: ["tono_devoto", "habla_de_rezos_y_misas", "modales_de_iglesia"],
    motivations: ["servir_a_la_iglesia", "tener_ingresos_estables"],
    fears: ["cerrar_la_iglesia", "perder_su_rol"],
    network: { betweenness: 0.15, degree: 9, aliados: ["padre_cecilio_sacerdote"], conflictos: [] },
  },
  {
    persona_id: "jhon_fredy_joven",
    display_name: "Jhon Fredy",
    role: "joven_retornado",
    age: 28,
    gender: "M",
    archetype: "joven_migrante",
    big_five: { O: 80, C: 42, E: 72, A: 48, N: 62 },
    lomnitz: { primary: "B", secondary: "A" },
    dunbar: { layer: 22, intimates: 6, best_friends: 3, aspirational: 13 },
    muletillas: ["parce", "nojoda", "esa vaina"],
    speaking_style: ["mezcla_registros", "critica_con_humor", "habla_de_plata_y_no_de_tierra"],
    motivations: ["encontrar_trabajo_digno", "tener_plata_propia"],
    fears: ["terminar_como_su_padre", "volver_a_bogota"],
    network: {
      betweenness: 0.1,
      degree: 7,
      aliados: ["dona_rosa_tendera"],
      conflictos: ["don_rosalio_ganadero"],
    },
  },
];

export const CIUDADES: { city_id: string; display_name: string; personas: Persona[] }[] = [
  { city_id: "tello", display_name: "Tello, Huila", personas: TELLO_PERSONAS },
];
