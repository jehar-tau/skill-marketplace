// Hidden taxonomy (spec §7.1). Users never see these; the parser assigns one leaf.

export type RiskTier = 'standard' | 'in_home' | 'child_facing' | 'food';
export type Locale = 'en' | 'hi' | 'mr';

export type AttributeKey =
  | 'item'
  | 'diet'
  | 'quantity'
  | 'delivery'
  | 'notice_hours'
  | 'price'
  | 'subject'
  | 'grade'
  | 'mode';

export interface CategoryDef {
  slug: string;
  riskTier: RiskTier;
  remoteOk: boolean;
  labels: Record<Locale, string>;
  // Lower-cased keywords in English, Romanised Hindi/Marathi and Devanagari.
  keywords: string[];
  attributes: AttributeKey[];
}

const c = (
  slug: string,
  riskTier: RiskTier,
  labels: [string, string, string],
  keywords: string[],
  attributes: AttributeKey[] = ['item', 'price'],
  remoteOk = false,
): CategoryDef => ({
  slug,
  riskTier,
  remoteOk,
  labels: { en: labels[0], hi: labels[1], mr: labels[2] },
  keywords,
  attributes,
});

const FOOD: AttributeKey[] = ['item', 'diet', 'quantity', 'delivery', 'notice_hours', 'price'];
const TEACH: AttributeKey[] = ['subject', 'grade', 'mode', 'price'];

export const CATEGORIES: CategoryDef[] = [
  // --- Food
  c('food.prepared_meals', 'food', ['Home-cooked food', 'घर का खाना', 'घरगुती जेवण'],
    ['biryani', 'बिर्याणी', 'बिरयानी', 'pulao', 'पुलाव', 'curry', 'sabzi', 'sabji', 'भाजी', 'सब्जी', 'thali', 'थाळी', 'थाली',
     'jevan', 'जेवण', 'khana', 'खाना', 'cook food', 'homemade food', 'meal', 'lunch', 'dinner', 'poli bhaji', 'पोळी', 'chapati',
     'चपाती', 'roti', 'रोटी', 'misal', 'मिसळ', 'pav bhaji', 'पावभाजी', 'paneer', 'पनीर', 'chicken', 'चिकन', 'mutton', 'मटण', 'fish fry'],
    FOOD),
  c('food.tiffin_service', 'food', ['Tiffin service', 'टिफिन सेवा', 'डबा सेवा'],
    ['tiffin', 'टिफिन', 'dabba', 'डबा', 'mess', 'मेस', 'monthly meal', 'daily lunch box'], FOOD),
  c('food.baking', 'food', ['Cakes and baking', 'केक और बेकिंग', 'केक आणि बेकिंग'],
    ['cake', 'केक', 'cupcake', 'brownie', 'cookies', 'pastry', 'baking', 'bake', 'bread'], FOOD),
  c('food.snacks_sweets', 'food', ['Snacks and sweets', 'नाश्ता और मिठाई', 'फराळ आणि मिठाई'],
    ['snacks', 'faral', 'फराळ', 'ladoo', 'laddu', 'लाडू', 'लड्डू', 'chivda', 'चिवडा', 'chakli', 'चकली', 'mithai', 'मिठाई',
     'modak', 'मोदक', 'samosa', 'समोसा', 'namkeen', 'pickle', 'लोणचे', 'अचार', 'papad', 'पापड'], FOOD),
  c('food.catering', 'food', ['Catering', 'कैटरिंग', 'केटरिंग'],
    ['catering', 'caterer', 'केटरिंग', 'कैटरिंग', 'party food', 'function food', 'bulk order food'], FOOD),

  // --- Education
  c('education.school_tutoring', 'child_facing', ['School tutoring', 'स्कूल ट्यूशन', 'शालेय शिकवणी'],
    ['tuition', 'tution', 'tutor', 'ट्यूशन', 'शिकवणी', 'shikvani', 'maths', 'math', 'गणित', 'science', 'विज्ञान', 'homework',
     'class 10', '10th', 'ssc', 'cbse', 'icse', 'teach children', 'teach kids', 'दहावी', 'दसवीं', 'dasvi', 'dahavi'],
    TEACH, true),
  c('education.exam_coaching', 'standard', ['Exam coaching', 'परीक्षा कोचिंग', 'परीक्षा मार्गदर्शन'],
    ['jee', 'neet', 'nata', 'mpsc', 'upsc', 'cet', 'entrance exam', 'coaching', 'कोचिंग', 'competitive exam', 'स्पर्धा परीक्षा'],
    TEACH, true),
  c('education.languages', 'standard', ['Language teaching', 'भाषा शिक्षण', 'भाषा शिकवणे'],
    ['spoken english', 'english speaking', 'english class', 'german', 'french', 'japanese', 'marathi class', 'hindi class',
     'language class', 'इंग्रजी बोलणे', 'अंग्रेजी बोलना'], TEACH, true),
  c('education.music_dance', 'standard', ['Music and dance', 'संगीत और नृत्य', 'संगीत आणि नृत्य'],
    ['guitar', 'गिटार', 'tabla', 'तबला', 'harmonium', 'हार्मोनियम', 'singing', 'गाणे', 'गाना', 'vocal', 'keyboard', 'piano',
     'dance', 'नृत्य', 'डान्स', 'kathak', 'कथक', 'bharatanatyam', 'zumba', 'flute', 'बासरी'], TEACH, true),
  c('education.art_design', 'standard', ['Art and design teaching', 'कला और डिज़ाइन', 'कला आणि डिझाइन'],
    ['drawing', 'चित्रकला', 'ड्रॉइंग', 'painting', 'पेंटिंग', 'sketching', 'design class', 'art class', 'calligraphy', 'craft class'],
    TEACH, true),
  c('education.computer_skills', 'standard', ['Computer skills', 'कंप्यूटर कौशल', 'संगणक कौशल्य'],
    ['computer class', 'excel', 'tally', 'typing', 'ms office', 'coding class', 'programming class', 'python class', 'संगणक'],
    TEACH, true),

  // --- Home services
  c('home.electrical', 'in_home', ['Electrician', 'इलेक्ट्रीशियन', 'इलेक्ट्रिशियन'],
    ['electrician', 'इलेक्ट्रीशियन', 'इलेक्ट्रिशियन', 'wiring', 'वायरिंग', 'switch', 'fan repair', 'पंखा', 'light fitting', 'mcb',
     'inverter', 'बिजली', 'वीज']),
  c('home.plumbing', 'in_home', ['Plumber', 'प्लंबर', 'प्लंबर'],
    ['plumber', 'प्लंबर', 'plumbing', 'tap', 'नळ', 'नल', 'leak', 'leakage', 'गळती', 'pipe', 'पाइप', 'drain', 'toilet repair',
     'water tank', 'geyser fitting']),
  c('home.carpentry', 'in_home', ['Carpenter', 'बढ़ई', 'सुतार'],
    ['carpenter', 'सुतार', 'बढ़ई', 'furniture', 'फर्निचर', 'फर्नीचर', 'door repair', 'wardrobe', 'cupboard', 'कपाट', 'wood work']),
  c('home.painting', 'in_home', ['House painting', 'घर की पुताई', 'घराचे रंगकाम'],
    ['house painting', 'wall painting', 'painter', 'रंगकाम', 'रंगारी', 'पुताई', 'whitewash', 'waterproofing']),
  c('home.appliance_repair', 'in_home', ['Appliance repair', 'उपकरण मरम्मत', 'उपकरण दुरुस्ती'],
    ['ac repair', 'ac service', 'ac', 'एसी', 'fridge', 'फ्रिज', 'refrigerator', 'washing machine', 'वॉशिंग मशीन', 'microwave', 'tv repair',
     'टीव्ही', 'टीवी', 'mixer repair', 'geyser repair', 'ro service', 'water purifier', 'दुरुस्ती', 'मरम्मत']),
  c('home.cleaning', 'in_home', ['Home cleaning', 'घर की सफाई', 'घर साफसफाई'],
    ['cleaning', 'सफाई', 'साफसफाई', 'deep clean', 'sofa cleaning', 'bathroom cleaning', 'kitchen cleaning', 'maid', 'कामवाली',
     'housekeeping', 'झाडू', 'भांडी']),
  c('home.pest_control', 'in_home', ['Pest control', 'कीट नियंत्रण', 'पेस्ट कंट्रोल'],
    ['pest control', 'पेस्ट कंट्रोल', 'cockroach', 'झुरळ', 'termite', 'वाळवी', 'दीमक', 'bed bugs', 'mosquito treatment']),
  c('home.gardening', 'in_home', ['Gardening', 'बागवानी', 'बागकाम'],
    ['garden', 'gardening', 'बागकाम', 'बागवानी', 'माळी', 'माली', 'plants', 'झाडे', 'पौधे', 'lawn', 'terrace garden']),
  c('home.cook_at_home', 'in_home', ['Cook at your home', 'घर पर रसोइया', 'घरी स्वयंपाक'],
    ['cook at home', 'home cook', 'स्वयंपाकी', 'स्वयंपाक', 'रसोइया', 'maharaj', 'महाराज', 'cook for family', 'private chef'],
    ['item', 'diet', 'price']),

  // --- Care
  c('care.babysitting', 'child_facing', ['Child care', 'बच्चों की देखभाल', 'मुलांची देखभाल'],
    ['babysitter', 'babysitting', 'nanny', 'child care', 'daycare', 'पाळणाघर', 'मुलांची देखभाल', 'बच्चों की देखभाल', 'आया']),
  c('care.elder_care', 'in_home', ['Elder care', 'बुजुर्गों की देखभाल', 'वृद्ध देखभाल'],
    ['elder care', 'elderly', 'caretaker', 'care taker', 'वृद्ध', 'बुजुर्ग', 'आजी आजोबा', 'attendant', 'nursing care', 'patient care']),
  c('care.pet_care', 'standard', ['Pet care', 'पालतू देखभाल', 'पाळीव प्राणी देखभाल'],
    ['pet', 'dog walking', 'dog walker', 'कुत्रा', 'कुत्ता', 'pet sitting', 'pet grooming', 'cat sitting', 'मांजर', 'बिल्ली']),

  // --- Personal
  c('personal.beauty', 'in_home', ['Beauty and grooming', 'ब्यूटी सेवा', 'ब्युटी सेवा'],
    ['beauty', 'ब्यूटी', 'ब्युटी', 'parlour', 'parlor', 'पार्लर', 'facial', 'waxing', 'haircut', 'hair cut', 'केस कापणे', 'makeup',
     'मेकअप', 'bridal', 'salon', 'threading']),
  c('personal.mehendi', 'standard', ['Mehendi', 'मेहंदी', 'मेहंदी'], ['mehendi', 'mehndi', 'मेहंदी', 'henna']),
  c('personal.tailoring', 'standard', ['Tailoring', 'सिलाई', 'शिवणकाम'],
    ['tailor', 'tailoring', 'शिवणकाम', 'शिंपी', 'सिलाई', 'दर्जी', 'blouse', 'ब्लाउज', 'stitching', 'alteration', 'fall pico',
     'फॉल पिको', 'dress stitching']),
  c('personal.fitness', 'standard', ['Fitness and yoga', 'फिटनेस और योग', 'फिटनेस आणि योग'],
    ['yoga', 'योग', 'योगा', 'gym trainer', 'personal trainer', 'fitness', 'pilates', 'व्यायाम'], ['mode', 'price'], true),
  c('personal.laundry', 'standard', ['Laundry and ironing', 'धुलाई और प्रेस', 'धुलाई आणि इस्त्री'],
    ['laundry', 'ironing', 'इस्त्री', 'प्रेस', 'dry clean', 'धोबी', 'washing clothes']),

  // --- Events
  c('events.photography', 'standard', ['Photography', 'फोटोग्राफी', 'फोटोग्राफी'],
    ['photographer', 'photography', 'फोटोग्राफर', 'फोटोग्राफी', 'photo shoot', 'photoshoot', 'videography', 'video shoot',
     'wedding shoot', 'pre wedding']),
  c('events.decoration', 'standard', ['Event decoration', 'सजावट', 'सजावट'],
    ['decoration', 'decorator', 'सजावट', 'डेकोरेशन', 'balloon', 'rangoli', 'रांगोळी', 'रंगोली', 'flower decoration', 'mandap',
     'birthday decoration']),
  c('events.priest', 'standard', ['Pooja and rituals', 'पूजा और अनुष्ठान', 'पूजा आणि विधी'],
    ['pooja', 'puja', 'पूजा', 'गुरुजी', 'guruji', 'पंडित', 'pandit', 'भटजी', 'satyanarayan', 'सत्यनारायण', 'vastu shanti']),
  c('events.entertainment', 'standard', ['Event entertainment', 'मनोरंजन', 'मनोरंजन'],
    ['dj', 'anchor', 'emcee', 'magician', 'जादूगार', 'band', 'live music', 'singer for event', 'dhol', 'ढोल']),

  // --- Tech and digital
  c('tech.web_development', 'standard', ['Website and app building', 'वेबसाइट निर्माण', 'वेबसाइट बनवणे'],
    ['website', 'वेबसाइट', 'web development', 'web developer', 'wordpress', 'shopify', 'landing page', 'app development',
     'android app', 'build a site', 'ecommerce site'], ['item', 'price'], true),
  c('tech.device_repair', 'standard', ['Phone and computer repair', 'फोन और कंप्यूटर मरम्मत', 'फोन आणि संगणक दुरुस्ती'],
    ['mobile repair', 'phone repair', 'मोबाईल दुरुस्ती', 'मोबाइल रिपेयर', 'screen replacement', 'laptop repair', 'लॅपटॉप',
     'लैपटॉप', 'computer repair', 'printer', 'wifi setup', 'cctv']),
  c('tech.graphic_design', 'standard', ['Graphic design', 'ग्राफिक डिज़ाइन', 'ग्राफिक डिझाइन'],
    ['logo', 'लोगो', 'graphic design', 'poster', 'banner', 'बॅनर', 'visiting card', 'invitation card', 'पत्रिका', 'flyer',
     'social media post', 'brochure'], ['item', 'price'], true),
  c('tech.video_editing', 'standard', ['Video editing', 'वीडियो एडिटिंग', 'व्हिडिओ एडिटिंग'],
    ['video editing', 'video editor', 'reels', 'रील', 'youtube editing', 'animation'], ['item', 'price'], true),
  c('tech.digital_marketing', 'standard', ['Digital marketing', 'डिजिटल मार्केटिंग', 'डिजिटल मार्केटिंग'],
    ['digital marketing', 'seo', 'instagram marketing', 'social media manager', 'ads campaign', 'google ads'],
    ['item', 'price'], true),

  // --- Professional
  c('pro.accounting_tax', 'standard', ['Accounting and tax', 'अकाउंटिंग और टैक्स', 'अकाउंटिंग आणि कर'],
    ['accountant', 'accounting', 'gst', 'income tax', 'itr', 'tax filing', 'bookkeeping', 'हिशोब', 'हिसाब', 'ca '],
    ['item', 'price'], true),
  c('pro.writing_translation', 'standard', ['Writing and translation', 'लेखन और अनुवाद', 'लेखन आणि भाषांतर'],
    ['translation', 'translator', 'भाषांतर', 'अनुवाद', 'content writing', 'resume', 'cv writing', 'typing work', 'proofreading',
     'data entry'], ['item', 'price'], true),
  c('pro.documents', 'standard', ['Document help', 'दस्तावेज़ सहायता', 'कागदपत्र मदत'],
    ['aadhaar', 'aadhar', 'आधार', 'pan card', 'पॅन कार्ड', 'passport', 'पासपोर्ट', 'agreement', 'rent agreement', 'notary',
     'form filling', 'कागदपत्र', 'दस्तावेज']),

  // --- Transport and errands
  c('transport.driver', 'standard', ['Driver', 'ड्राइवर', 'ड्रायव्हर'],
    ['driver', 'ड्रायव्हर', 'ड्राइवर', 'chauffeur', 'driving for', 'outstation driver']),
  c('transport.driving_lessons', 'standard', ['Driving lessons', 'ड्राइविंग सिखाना', 'ड्रायव्हिंग शिकवणे'],
    ['गाडी चालवायला', 'गाड़ी चलाना', 'driving class', 'driving lesson', 'learn driving', 'driving school', 'गाडी शिकवणे', 'गाड़ी सिखाना']),
  c('transport.moving', 'standard', ['Moving and delivery', 'शिफ्टिंग और डिलीवरी', 'शिफ्टिंग आणि डिलिव्हरी'],
    ['packers', 'movers', 'shifting', 'शिफ्टिंग', 'tempo', 'टेम्पो', 'delivery boy', 'pickup drop', 'courier', 'parcel', 'errand',
     'सामान']),
  c('transport.vehicle_service', 'standard', ['Vehicle repair and wash', 'वाहन मरम्मत', 'वाहन दुरुस्ती'],
    ['bike repair', 'car repair', 'mechanic', 'मेकॅनिक', 'मैकेनिक', 'car wash', 'गाडी धुणे', 'puncture', 'पंक्चर', 'bike service',
     'two wheeler']),

  // --- Fallback
  c('other', 'standard', ['Other', 'अन्य', 'इतर'], []),
];

export const CATEGORY_BY_SLUG = new Map(CATEGORIES.map((x) => [x.slug, x]));

// Categories close enough that a request in one may be offered to a capability in the other.
export const CATEGORY_NEIGHBOURS: Record<string, string[]> = {
  'food.prepared_meals': ['food.tiffin_service', 'food.catering', 'food.snacks_sweets'],
  'food.tiffin_service': ['food.prepared_meals'],
  'food.catering': ['food.prepared_meals'],
  'food.snacks_sweets': ['food.prepared_meals', 'food.baking'],
  'food.baking': ['food.snacks_sweets'],
  'education.school_tutoring': ['education.exam_coaching'],
  'education.exam_coaching': ['education.school_tutoring'],
  'personal.beauty': ['personal.mehendi'],
  'personal.mehendi': ['personal.beauty'],
};

export function compatibleCategories(slug: string): string[] {
  return [slug, ...(CATEGORY_NEIGHBOURS[slug] ?? [])];
}
