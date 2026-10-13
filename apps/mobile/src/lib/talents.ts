import type { Locale } from './i18n';

// Ideas shown on the welcome screen so people recognise something they can do.
// This is inspiration only: anyone can describe a talent that is not listed.
export interface TalentGroup {
  icon: string;
  title: Record<Locale, string>;
  items: string[];
}

export const TALENT_GROUPS: TalentGroup[] = [
  {
    icon: '🍛',
    title: { en: 'Food and cooking', hi: 'खाना और रसोई', mr: 'जेवण आणि स्वयंपाक' },
    items: [
      'Home-cooked meals', 'Biryani orders', 'Daily tiffin', 'Office lunch boxes', 'Party catering', 'Birthday cakes', 'Cupcakes and brownies',
      'Homemade chocolates', 'Festival sweets', 'Diwali faral', 'Modak and puran poli', 'Pickles and papad', 'Masalas and chutneys', 'Healthy diet meals',
      'Baby food', 'Jain food', 'Regional specialities', 'Snacks for functions', 'Cooking at your home', 'Cooking classes', 'Baking classes', 'Juices and smoothies',
    ],
  },
  {
    icon: '📚',
    title: { en: 'Teaching and tutoring', hi: 'पढ़ाना और ट्यूशन', mr: 'शिकवणे आणि शिकवणी' },
    items: [
      'Maths tuition', 'Science tuition', 'English tuition', 'Marathi and Hindi tuition', 'Primary school tuition', 'Class 10 board preparation', 'Class 12 board preparation',
      'JEE and NEET coaching', 'Commerce and accounts tuition', 'Spoken English', 'Handwriting improvement', 'Phonics for young children', 'Abacus and Vedic maths',
      'Homework help', 'Competitive exam guidance', 'Sanskrit teaching', 'German, French or Japanese', 'Coding for children', 'Computer basics for adults', 'Excel and Tally training',
      'Public speaking', 'Interview preparation', 'Career guidance',
    ],
  },
  {
    icon: '🎸',
    title: { en: 'Music, dance and art', hi: 'संगीत, नृत्य और कला', mr: 'संगीत, नृत्य आणि कला' },
    items: [
      'Guitar lessons', 'Keyboard and piano lessons', 'Tabla lessons', 'Harmonium lessons', 'Flute lessons', 'Classical singing', 'Bollywood singing', 'Bhajan and kirtan',
      'Kathak', 'Bharatanatyam', 'Bollywood dance', 'Zumba', 'Wedding dance choreography', 'Drawing and sketching', 'Painting classes', 'Calligraphy', 'Craft classes',
      'Rangoli', 'Portrait sketches', 'Wall murals', 'Singing at events', 'Live band or DJ',
    ],
  },
  {
    icon: '🏏',
    title: { en: 'Sports and fitness', hi: 'खेल और फिटनेस', mr: 'खेळ आणि फिटनेस' },
    items: [
      'Cricket coaching', 'Football coaching', 'Badminton coaching', 'Table tennis coaching', 'Chess coaching', 'Swimming lessons', 'Skating lessons', 'Karate and self-defence',
      'Yoga classes', 'Personal fitness training', 'Home workouts', 'Running and marathon training', 'Cycling groups', 'Kabaddi and kho-kho coaching', 'Athletics coaching',
      'Diet and nutrition plans', 'Meditation sessions', 'Senior citizen exercise', 'Pre and post-natal yoga',
    ],
  },
  {
    icon: '💻',
    title: { en: 'Computers and digital', hi: 'कंप्यूटर और डिजिटल', mr: 'संगणक आणि डिजिटल' },
    items: [
      'Websites for shops', 'Online store setup', 'Mobile apps', 'Logo design', 'Posters and banners', 'Wedding invitations', 'Visiting cards', 'Social media handling',
      'Instagram reels editing', 'Video editing', 'Photo editing', 'Google listing for businesses', 'Online ads', 'Content writing', 'Translation', 'Resume writing',
      'Data entry', 'Typing work', 'PowerPoint presentations', 'Excel sheets and reports', 'Laptop and computer repair', 'Phone repair', 'Wi-Fi and CCTV setup', 'Printer setup',
    ],
  },
  {
    icon: '🔧',
    title: { en: 'Home repair and upkeep', hi: 'घर की मरम्मत', mr: 'घराची दुरुस्ती' },
    items: [
      'Plumbing', 'Electrical work', 'Carpentry', 'Furniture repair', 'House painting', 'Waterproofing', 'AC service', 'Fridge and washing machine repair', 'TV repair',
      'Water purifier service', 'Mixer and small appliance repair', 'Geyser fitting', 'Tile and masonry work', 'Home deep cleaning', 'Sofa and carpet cleaning', 'Water tank cleaning',
      'Pest control', 'Gardening', 'Terrace gardens', 'Curtains and blinds fitting', 'Modular kitchen work', 'Welding and grill work', 'Key making and locks',
    ],
  },
  {
    icon: '✂️',
    title: { en: 'Beauty, tailoring and care', hi: 'ब्यूटी, सिलाई और देखभाल', mr: 'ब्युटी, शिवणकाम आणि देखभाल' },
    items: [
      'Blouse stitching', 'Dress stitching', 'Alterations', 'Fall and pico', 'Embroidery', 'School uniform stitching', 'Bridal makeup', 'Party makeup', 'Mehendi',
      'Hair cutting at home', 'Hair styling', 'Facial and clean-up', 'Waxing and threading', 'Nail art', 'Saree draping', 'Massage for new mothers', 'Baby massage and bath',
      'Babysitting', 'Elder care', 'Patient attendant', 'Physiotherapy at home', 'Pet sitting', 'Dog walking', 'Pet grooming', 'Laundry and ironing',
    ],
  },
  {
    icon: '🎉',
    title: { en: 'Events and occasions', hi: 'कार्यक्रम और अवसर', mr: 'कार्यक्रम आणि समारंभ' },
    items: [
      'Wedding photography', 'Birthday photography', 'Baby photo shoots', 'Videography', 'Drone shoots', 'Balloon decoration', 'Flower decoration', 'Mandap decoration',
      'Ganpati decoration', 'Event anchoring', 'Magic shows', 'Games for children’s parties', 'Return gifts and hampers', 'Pooja and rituals', 'Astrology and kundali',
      'Wedding planning', 'Sound and lights on rent', 'Tent and chairs on rent', 'Dhol-tasha', 'Invitation printing',
    ],
  },
  {
    icon: '🚗',
    title: { en: 'Driving, moving and errands', hi: 'ड्राइविंग और काम-काज', mr: 'ड्रायव्हिंग आणि कामे' },
    items: [
      'Driver for the day', 'Outstation driver', 'Driving lessons', 'Two-wheeler lessons', 'Airport drop', 'School pick-up and drop', 'Tempo for shifting', 'Packing and moving',
      'Parcel delivery', 'Grocery and medicine runs', 'Queue and paperwork errands', 'Bike repair', 'Car repair', 'Car and bike washing', 'Puncture repair', 'Cycle repair',
    ],
  },
  {
    icon: '📑',
    title: { en: 'Paperwork and professional help', hi: 'कागज़ी काम और पेशेवर मदद', mr: 'कागदपत्रे आणि व्यावसायिक मदत' },
    items: [
      'Income tax returns', 'GST filing', 'Bookkeeping', 'PAN and Aadhaar help', 'Passport form help', 'Rent agreements', 'Insurance guidance', 'Loan paperwork help',
      'Property document help', 'Shop licence help', 'Legal drafting', 'Notary help', 'Society accounts', 'Business registration help', 'Online form filling',
    ],
  },
  {
    icon: '🧵',
    title: { en: 'Handmade and home business', hi: 'हाथ का बना और घरेलू व्यवसाय', mr: 'हस्तकला आणि घरगुती व्यवसाय' },
    items: [
      'Handmade jewellery', 'Candles and soaps', 'Crochet and knitting', 'Cloth bags', 'Gift wrapping', 'Customised gifts', 'Printed T-shirts and mugs', 'Rakhi and festival items',
      'Clay and pottery items', 'Home plants and nursery', 'Homemade snacks for sale', 'Organic vegetables', 'Dairy and ghee', 'Second-hand books', 'Toys and games rental',
      'Reselling clothes', 'Photo frames and albums',
    ],
  },
];

export const TALENT_COUNT = TALENT_GROUPS.reduce((n, g) => n + g.items.length, 0);
