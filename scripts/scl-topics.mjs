/**
 * SCL topic taxonomy — shared across import, backfill, and search.
 * Covers IDB Social Sector (SCL) Knowledge Agenda 2025-2026 priorities.
 */

export const SCL_TOPICS = {
  ecd: [
    'early childhood', 'child development', 'parenting program', 'home visiting',
    'nurturing care', 'early stimulation', 'reach up', 'preschool', 'kindergarten',
    'ecd', 'early intervention', 'child mental health', 'infant', 'toddler',
    'caregiver training', 'mother child', 'early years', 'child welfare',
    'daycare', 'childcare', 'creche', 'head start', 'early education',
    'developmental delay', 'school readiness', 'cognitive stimulation',
    'responsive caregiving', 'early childhood program', 'primera infancia',
    'desarrollo infantil', 'cuidado infantil', 'estimulacion temprana'
  ],
  education: [
    'teacher effectiveness', 'teacher quality', 'teacher sorting', 'teacher allocation',
    'school quality', 'learning outcomes', 'education technology', 'edtech',
    'ai tutor', 'ai teacher', 'ai bot teacher', 'cell phone ban', 'college access',
    'dropout', 'stem education', 'literacy', 'numeracy', 'curriculum',
    'principal leadership', 'teacher training', 'teacher recruitment',
    'smart spending education', 'school efficiency', 'remote tutoring',
    'student achievement', 'test score', 'pisa', 'terce', 'serce',
    'private school', 'voucher', 'charter school', 'education reform',
    'higher education', 'university access', 'school dropout', 'retention school',
    'educacion', 'maestro', 'docente', 'escuela', 'aprendizaje'
  ],
  labor_markets: [
    'labor market', 'labour market', 'employment', 'wage subsidy',
    'tvet', 'vocational training', 'skills certification', 'active labor market',
    'public employment service', 'unemployment', 'informal employment',
    'informality', 'monopsony', 'labor regulation', 'minimum wage',
    'job training', 'digital skills', 'workforce development', 'occupational',
    'labor productivity', 'wage inequality', 'labor formalization',
    'cerrando brechas', 'taxing wages', 'produce more distribute better',
    'mercado laboral', 'empleo', 'desempleo', 'salario', 'capacitacion'
  ],
  social_protection: [
    'cash transfer', 'conditional cash', 'unconditional cash', 'cct',
    'social protection', 'social registry', 'social assistance', 'safety net',
    'bolsa familia', 'progresa', 'oportunidades', 'familias en accion',
    'targeting', 'beneficiary selection', 'social insurance', 'social spending',
    'food stamps', 'in-kind transfer', 'workfare', 'social registry',
    'welfare program', 'anti-poverty', 'poverty targeting',
    'transferencias condicionadas', 'proteccion social', 'registro social'
  ],
  aging_ltc: [
    'aging', 'ageing', 'elderly', 'older adult', 'older worker',
    'pension', 'retirement', 'long-term care', 'dementia', 'alzheimer',
    'frail elderly', 'informal caregiver', 'caregiver burden',
    'geriatric', 'elder care', 'care economy', 'social care',
    'nursing home', 'home care', 'pension reform', 'aging population',
    'population aging', 'silver economy', 'care for elderly',
    'envejecimiento', 'adulto mayor', 'pension', 'cuidado largo plazo',
    'cuidados informales'
  ],
  health: [
    'health system', 'hospital efficiency', 'hospital performance',
    'primary care', 'ncd', 'non-communicable disease', 'chronic disease',
    'maternal health', 'digital health', 'telemedicine', 'mhealth',
    'health insurance', 'universal health', 'quality of care',
    'health equity', 'health reform', 'biosimilar', 'generic drug',
    'hospital acquired infection', 'neonatal', 'child mortality',
    'immunization', 'vaccination', 'salud mesoamerica', 'hearts',
    'primary health care', 'community health worker', 'health worker',
    'health expenditure', 'out-of-pocket', 'catastrophic health',
    'hypertension', 'diabetes', 'obesity', 'cardiovascular',
    'resilient health system', 'health system resilience',
    'salud', 'hospital', 'atencion primaria', 'seguro de salud',
    'sistema de salud', 'salud materna'
  ],
  gender_gbv: [
    'gender-based violence', 'gbv', 'intimate partner violence', 'ipv',
    'domestic violence', 'gender norms', 'gbv shelter', 'femicide',
    'sexual violence', 'women empowerment', 'gender equality',
    'care work', 'division of labor', 'unpaid care', 'gender gap',
    'gender discrimination', 'glass ceiling', 'pay gap', 'gender wage',
    'maternal leave', 'parental leave', 'gender in hiring',
    'gender in credit', 'microcredit women', 'women entrepreneurship',
    'violencia de genero', 'violencia domestica', 'violencia intrafamiliar',
    'brecha de genero', 'empoderamiento femenino', 'cuidado no remunerado'
  ],
  diversity: [
    'afro-descendant', 'afrodescendant', 'afro descendant',
    'racial inequality', 'racial discrimination', 'racial bias',
    'race', 'racial gap', 'intergenerational mobility race',
    'ethnic inequality', 'indigenous population', 'indigena',
    'afro-latino', 'structural racism', 'skin color', 'colorism',
    'hiring discrimination race', 'racial concordance',
    'raza', 'afrodescendiente', 'pueblos indigenas',
    'desigualdad racial', 'discriminacion racial'
  ],
  migration: [
    'migration', 'migrant', 'refugee', 'asylum seeker', 'displacement',
    'venezuelan migration', 'regularization', 'immigrant integration',
    'social cohesion migrants', 'return migration', 'remittance',
    'undocumented', 'forced displacement', 'unhcr', 'skills certification migrants',
    'host community', 'migrant worker', 'saber hacer vale',
    'migracion', 'migrante', 'refugiado', 'desplazado',
    'integracion migrante', 'regularizacion migratoria',
    'migracion venezolana', 'migracion centroamerica'
  ],
  ai_digital: [
    'artificial intelligence', 'machine learning', 'automation impact',
    'ai impact', 'digital transformation', 'platform economy',
    'algorithm', 'fintech', 'govtech', 'ai education', 'ai in labor',
    'robot', 'job displacement', 'future of work', 'ai bias',
    'ai health', 'ai hiring', 'algorithmic', 'digital public service',
    'ai automation', 'task automation', 'technology unemployment',
    'inteligencia artificial', 'automatizacion', 'transformacion digital',
    'plataformas digitales'
  ],
  climate_resilience: [
    'adaptive social protection', 'climate social protection',
    'climate shock', 'disaster risk', 'resilience', 'vulnerability',
    'climate adaptation', 'natural disaster', 'flood', 'drought',
    'extreme weather', 'drm', 'disaster management',
    'climate change human capital', 'climate early childhood',
    'proteccion social adaptativa', 'riesgo climatico',
    'resiliencia climatica', 'desastres naturales'
  ],
};

/**
 * Classify a paper into SCL topics based on title + abstract.
 * Returns array of matching topic keys.
 */
export function classifyTopics(title = '', abstract = '') {
  const text = `${title} ${abstract}`.toLowerCase();
  return Object.entries(SCL_TOPICS)
    .filter(([, keywords]) => keywords.some(kw => text.includes(kw.toLowerCase())))
    .map(([topic]) => topic);
}

/**
 * Human-readable labels for each topic key.
 */
export const SCL_TOPIC_LABELS = {
  ecd:               'Early Childhood Development',
  education:         'Education',
  labor_markets:     'Skills & Labor Markets',
  social_protection: 'Social Protection',
  aging_ltc:         'Aging & Long-Term Care',
  health:            'Health Systems',
  gender_gbv:        'Gender & GBV',
  diversity:         'Diversity & Racial Equity',
  migration:         'Migration & Integration',
  ai_digital:        'AI & Digital Transformation',
  climate_resilience:'Climate Resilience',
};
