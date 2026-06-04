// Genus detector — JS port of add_genus.py.
const GENERA = ["Austrocylindropuntia","Zamioculcas","Schlumbergera","Spathiphyllum","Sansevieria","Tradescantia","Trichodiadema","Rhaphidophora","Cleistocactus","Pachycereus","Pilosocereus","Stenocactus","Thelocactus","Pachyphytum","Pachypodium","Pachyveria","Stenocereus","Pachycormus","Echinocactus","Echinocereus","Echinopsis","Selenicereus","Selaginella","Disocactus","Calandiva","Dieffenbachia","Pleomele","Chlorophytum","Epipremnum","Aglaonema","Anthurium","Philodendron","Scindapsus","Polyscias","Rhipsalidopsis","Sempervivum","Stromanthe","Schefflera","Tillandsia","Aichryson","Goeppertia","Ctenanthe","Zantedeschia","Adansonia","Hesperaloe","Pseudolithos","Pseuderanthemum","Argyroderma","Astrophytum","Aloinopsis","Anacampseros","Gymnocalycium","Setiechinopsis","Strophocactus","Beaucarnea","Aeschynanthus","Saintpaulia","Hypoestes","Nephrolepis","Asplenium","Adiantum","Phlebodium","Davallia","Polypodium","Pellaea","Pteris","Polystichum","Aechmea","Guzmania","Vriesea","Cryptanthus","Neoregelia","Cordyline","Codiaeum","Dracaena","Dypsis","Chamaedorea","Aspidistra","Aphelandra","Apoballis","Plectranthus","Strelitzia","Stapelia","Stenotaphrum","Pellionia","Adromischus","Adenium","Adenia","Aeonium","Albuca","Alocasia","Amydrium","Aptenia","Asparagus","Begonia","Bowiea","Bryophyllum","Calathea","Ceropegia","Cissus","Cotyledon","Crassula","Cycas","Cyanotis","Cyphostemma","Delosperma","Dorstenia","Drosanthemum","Dudleya","Dyckia","Echeveria","Epiphyllum","Euphorbia","Faucaria","Fenestraria","Ferocactus","Ficus","Fittonia","Frithia","Fockea","Gasteria","Gerbera","Glottiphyllum","Graptopetalum","Graptosedum","Graptoveria","Greenovia","Hatiora","Haworthia","Haworthiopsis","Hechtia","Hedera","Howea","Hoya","Huernia","Hylocereus","Jatropha","Kalanchoe","Lithops","Ludisia","Mammillaria","Manfreda","Mangave","Maranta","Matucana","Melocactus","Monilaria","Monstera","Myrtillocactus","Notocactus","Opuntia","Oreocereus","Orostachys","Oscularia","Othonna","Pachira","Parodia","Pedilanthus","Pelargonium","Peperomia","Pereskia","Pilea","Pleiospilos","Plumeria","Pothos","Portulacaria","Puya","Portulaca","Rebutia","Rhipsalis","Rhombophyllum","Ruschia","Sarcocaulon","Saxifraga","Sedeveria","Sedum","Senecio","Sinningia","Sinocrassula","Syngonium","Tacca","Tavaresia","Titanopsis","Trichocereus","Tylecodon","Uncarina","Welwitschia","Yucca","Zamia","Zebrina","Aloe","Agave","Curio","Calliandra","Callisia","Coffea","Cussonia","Cereus","Soleirolia","Olea","Espostoa","Lapidaria","Ledebouria","Mammilloydia","Phalaenopsis","Cyclamen","Tephrocactus","Cremnosedum","Polaskia","Gasteraloe","Semponium","Xanthosoma","Pachysedum","Homalomena","Fatsia","Farfugium","Edithcolea","Geogenanthus","Xerosicyos","Platycerium","Cupressus","Juniperus","Araucaria","Faumatium","Acanthocereus","Consolea","Hydnophytum","Lepismium","Lobivia"];
const GENUS_PATTERNS = GENERA.map(g => [g, new RegExp("\\b" + g.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + "\\b", "i")]);
const COMMON_NAMES = [["Spider Plant","Chlorophytum"],["ZZ Plant","Zamioculcas"],["ZZ Zamioculcas","Zamioculcas"],["Snake Plant","Dracaena"],["Pothos","Epipremnum"],["Money Tree","Pachira"],["String of Pearls","Senecio"],["String of Hearts","Ceropegia"],["String of Turtles","Peperomia"],["String of Bananas","Senecio"],["String of Tears","Senecio"],["String of Dolphins","Senecio"],["String of Fishhooks","Senecio"],["Ruby Necklace","Othonna"],["Calla Lily","Zantedeschia"],["Fishbone Cactus","Epiphyllum"],["Christmas Cactus","Schlumbergera"],["Thanksgiving Cactus","Schlumbergera"],["Easter Cactus","Hatiora"],["Moon Cactus","Gymnocalycium"],["Bunny Ear","Opuntia"],["Prickly Pear","Opuntia"],["Pincushion Cactus","Mammillaria"],["Old Man Cactus","Cephalocereus"],["Bishop","Astrophytum"],["Star Cactus","Astrophytum"],["Boston Fern","Nephrolepis"],["Bird's Nest","Asplenium"],["Maidenhair Fern","Adiantum"],["Blue Star Fern","Phlebodium"],["Rabbit Foot Fern","Davallia"],["Button Fern","Pellaea"],["Brake Fern","Pteris"],["Korean Rock","Polystichum"],["Crocodile","Microsorum"],["Austral Gem","Asplenium"],["Mahogany Fern","Didymochlaena"],["Lemon Button","Nephrolepis"],["Sprengeri","Asparagus"],["Staghorn","Platycerium"],["Rubber Plant","Ficus"],["Rubber Tree","Ficus"],["Fiddle Leaf","Ficus"],["Weeping Fig","Ficus"],["Umbrella Plant","Schefflera"],["Umbrella Tree","Schefflera"],["Chinese Evergreen","Aglaonema"],["Croton","Codiaeum"],["Dragon Tree","Dracaena"],["Polka Dot Plant","Hypoestes"],["Prayer Plant","Maranta"],["Peacock Plant","Calathea"],["Rattlesnake Plant","Calathea"],["Nerve Plant","Fittonia"],["Wandering Jew","Tradescantia"],["Wandering Dude","Tradescantia"],["Inch Plant","Tradescantia"],["Oyster Plant","Tradescantia"],["Moses in the Cradle","Tradescantia"],["Spanish Moss","Tillandsia"],["Air Plant","Tillandsia"],["Airplant","Tillandsia"],["Ionantha","Tillandsia"],["Xerographica","Tillandsia"],["Caput-Medusae","Tillandsia"],["Bromeliad","Neoregelia"],["Ponytail Palm","Beaucarnea"],["Palm Ponytail","Beaucarnea"],["Areca Palm","Dypsis"],["Parlor Palm","Chamaedorea"],["Neanthe Bella","Chamaedorea"],["Cast Iron Plant","Aspidistra"],["African Violet","Saintpaulia"],["Lipstick Plant","Aeschynanthus"],["Lipstick Black Pagoda","Aeschynanthus"],["Goldfish Plant","Nematanthus"],["Mother of Thousands","Kalanchoe"],["Mother of Millions","Kalanchoe"],["Panda Plant","Kalanchoe"],["Flaming Katy","Kalanchoe"],["Flapjack","Kalanchoe"],["Paddle Plant","Kalanchoe"],["Donkey Tail","Sedum"],["Donkey's Tail","Sedum"],["Burro Tail","Sedum"],["Burrito","Sedum"],["Watch Chain","Crassula"],["Calico Kitten","Crassula"],["Jade Plant","Crassula"],["Buddha's Temple","Crassula"],["Baby Toes","Fenestraria"],["Ice Plant","Corpuscularia"],["Pickle Plant","Delosperma"],["Hens and Chicks","Sempervivum"],["Houseleek","Sempervivum"],["Echeveria","Echeveria"],["African Mask","Alocasia"],["Elephant Ear","Alocasia"],["Silver Dragon","Alocasia"],["Swiss Cheese","Monstera"],["Spiderman Monstera","Amydrium"],["Bird of Paradise","Strelitzia"],["Pencil Cactus","Euphorbia"],["Crown of Thorns","Euphorbia"],["Pinwheel","Aeonium"],["Hindu Rope","Hoya"],["Wax Plant","Hoya"],["Peace Lily","Spathiphyllum"],["Schefflera Arboricola","Schefflera"],["Pleomele","Dracaena"],["Lemon Lime","Dracaena"],["Janet Craig","Dracaena"],["Lucky Bamboo","Dracaena"],["Corn Plant","Dracaena"],["Madagascar Dragon","Dracaena"],["Aralia","Polyscias"],["Ming Aralia","Polyscias"],["Strawberry Begonia","Saxifraga"],["Strawberry Saxifrage","Saxifraga"],["Variegated Shark Fin","Sansevieria"],["Coral Cactus","Euphorbia"],["Pencil Plant","Euphorbia"],["Tree Aeonium","Aeonium"],["Coleus","Plectranthus"],["Coffee Plant","Coffea"],["Coffee Arabica","Coffea"],["Living Stone","Lithops"],["Split Rock","Pleiospilos"],["Mimicry Plant","Pleiospilos"],["Ghost Plant","Graptopetalum"],["English Ivy","Hedera"],["Green Ivy Plant","Hedera"],["Norfolk","Araucaria"],["Olive Tree","Olea"],["Baby's Tear","Soleirolia"],["Nettle Baby","Soleirolia"],["Boobie Cactus","Myrtillocactus"],["Phalaenopsis","Phalaenopsis"],["Orchid","Phalaenopsis"],["Poinsettia","Euphorbia"],["Christmas Plant","Euphorbia"],["Cypress","Cupressus"],["Bonsai Juniper","Juniperus"],["Fairy Castle","Acanthocereus"],["Silver Dollar Vine","Xerosicyos"],["Silver Squill","Ledebouria"],["Karoo Rose","Lapidaria"],["Mistletoe Cactus","Rhipsalis"],["Mouse Tail Cactus","Lepismium"],["Paper Spine","Tephrocactus"],["Pine Cone Cactus","Tephrocactus"],["Roadkill Cactus","Consolea"],["Chinese Dunce Cap","Orostachys"],["Persian Carpet","Edithcolea"],["Peruvian Old Lady","Espostoa"],["Snowball Cactus","Mammilloydia"],["Chick Charms","Sempervivum"],["Chick Charmlettes","Sempervivum"],["Ant Plant","Hydnophytum"],["Velvet Forest","Begonia"],["Cereus","Cereus"],[" Ivy","Hedera"],[" Fern","Nephrolepis"]];
const NON_PLANT = ["subscription","gift card","gift box","variety pack","variety bundle","variety mix","succulent pack","houseplant pack","plant pack","10-pack","10 pack","5-pack","5 pack","4-pack","4 pack","12-pack","12 pack","dish garden","terrarium kit","garden kit","planter","fertilizer","moss","rocks","pumice","perlite","lava rock","watering","tweezer","scissors","ceramic","concrete","assorted","mystery","surprise","random","month |","macrame","hanger","box of","wedding","wholesale","discount card","grow light","humidifier","starter kit","succulent kit","fairy garden","heat pack","coaster","printable","snaps set","coloring book","stuffed","sparkler","calendar","bookmark","potting kit","id cards","chart","dust blower","bulk pack","repotting mat","grape wood","top dressing","auto renew","5-7 days","warmest wishes","happy valentine","tricolor","all in this together","plant waterer","rosette succulent bulk","best selling bundle","heart arrangement","holiday tree","snap set","coloring page","crochet","the victorian","ruby glow","nettle"];
const WB_KEYWORDS = ["pot","tool","tray","stand","shelf","saucer","card","soil"];
const WB_PATTERNS = Object.fromEntries(WB_KEYWORDS.map(k => [k, new RegExp("\\b" + k + "\\b")]));
function detectGenus(title){
  if (!title) return "";
  const t = title.trim(); const low = t.toLowerCase();
  if (low === "blank") return "";
  const matches = [];
  for (const [g, pat] of GENUS_PATTERNS) if (pat.test(t)) matches.push(g);
  if (matches.length) { matches.sort((a,b) => b.length - a.length); return matches[0]; }
  for (const [phrase, g] of COMMON_NAMES) if (low.includes(phrase.toLowerCase())) return g;
  for (const kw of NON_PLANT) {
    if (WB_KEYWORDS.includes(kw)) { if (WB_PATTERNS[kw].test(low)) return ""; }
    else if (low.includes(kw)) return "";
  }
  return "";
}

// Genus → plant type, derived from succulentsbox.com collection breakdown.
const GENUS_TYPE = {
  // Succulents
  "Adenia":"Succulent","Adenium":"Succulent","Adromischus":"Succulent","Aeonium":"Succulent",
  "Agave":"Succulent","Albuca":"Succulent","Aloe":"Succulent","Aloinopsis":"Succulent",
  "Anacampseros":"Succulent","Argyroderma":"Succulent","Astrophytum":"Succulent",
  "Austrocylindropuntia":"Succulent","Ceropegia":"Succulent","Cleistocactus":"Succulent",
  "Corpuscularia":"Succulent","Cotyledon":"Succulent","Crassula":"Succulent","Cremnosedum":"Succulent",
  "Curio":"Succulent","Echeveria":"Succulent","Echinocactus":"Succulent","Echinocereus":"Succulent",
  "Echinopsis":"Succulent","Edithcolea":"Succulent","Epiphyllum":"Succulent","Espostoa":"Succulent",
  "Euphorbia":"Succulent","Faucaria":"Succulent","Fenestraria":"Succulent","Ferocactus":"Succulent",
  "Gasteraloe":"Succulent","Gasteria":"Succulent","Graptopetalum":"Succulent","Graptosedum":"Succulent",
  "Graptoveria":"Succulent","Greenovia":"Succulent","Gymnocalycium":"Succulent","Hatiora":"Succulent",
  "Haworthia":"Succulent","Haworthiopsis":"Succulent","Hoya":"Succulent","Huernia":"Succulent",
  "Kalanchoe":"Succulent","Lapidaria":"Succulent","Ledebouria":"Succulent","Lepismium":"Succulent",
  "Lithops":"Succulent","Mammillaria":"Succulent","Mammilloydia":"Succulent","Mangave":"Succulent",
  "Myrtillocactus":"Succulent","Notocactus":"Succulent","Opuntia":"Succulent","Orostachys":"Succulent",
  "Oscularia":"Succulent","Othonna":"Succulent","Pachycereus":"Succulent","Pachyphytum":"Succulent",
  "Pachypodium":"Succulent","Pachysedum":"Succulent","Pachyveria":"Succulent","Parodia":"Succulent",
  "Pelargonium":"Succulent","Peperomia":"Succulent","Plectranthus":"Succulent","Pleiospilos":"Succulent",
  "Polaskia":"Succulent","Portulaca":"Succulent","Portulacaria":"Succulent","Rebutia":"Succulent",
  "Rhipsalis":"Succulent","Rhombophyllum":"Succulent","Ruschia":"Succulent","Schlumbergera":"Succulent",
  "Sedeveria":"Succulent","Sedum":"Succulent","Semponium":"Succulent","Sempervivum":"Succulent",
  "Senecio":"Succulent","Sinocrassula":"Succulent","Stapelia":"Succulent","Stenocactus":"Succulent",
  "Tephrocactus":"Succulent","Thelocactus":"Succulent","Titanopsis":"Succulent","Tradescantia":"Succulent",
  "Trichodiadema":"Succulent","Tylecodon":"Succulent","Xerosicyos":"Succulent","Yucca":"Succulent",
  "Aichryson":"Succulent","Callisia":"Succulent","Delosperma":"Succulent","Consolea":"Succulent",
  "Acanthocereus":"Succulent","Cereus":"Succulent",
  // Houseplants
  "Aglaonema":"Houseplant","Alocasia":"Houseplant","Amydrium":"Houseplant","Anthurium":"Houseplant",
  "Aphelandra":"Houseplant","Apoballis":"Houseplant","Aralia":"Houseplant","Araucaria":"Houseplant",
  "Ardisia":"Houseplant","Asparagus":"Houseplant","Aspidistra":"Houseplant","Asplenium":"Houseplant",
  "Adiantum":"Houseplant","Beaucarnea":"Houseplant","Begonia":"Houseplant","Calathea":"Houseplant",
  "Calliandra":"Houseplant","Chamaedorea":"Houseplant","Chlorophytum":"Houseplant","Codiaeum":"Houseplant",
  "Coffea":"Houseplant","Cordyline":"Houseplant","Ctenanthe":"Houseplant","Cupressus":"Houseplant",
  "Cycas":"Houseplant","Davallia":"Houseplant","Dieffenbachia":"Houseplant","Dracaena":"Houseplant",
  "Dypsis":"Houseplant","Epipremnum":"Houseplant","Farfugium":"Houseplant","Fatsia":"Houseplant",
  "Ficus":"Houseplant","Fittonia":"Houseplant","Geogenanthus":"Houseplant","Gerbera":"Houseplant",
  "Goeppertia":"Houseplant","Hedera":"Houseplant","Hesperaloe":"Houseplant","Homalomena":"Houseplant",
  "Hypoestes":"Houseplant","Juniperus":"Houseplant","Ludisia":"Houseplant","Maranta":"Houseplant",
  "Microsorum":"Houseplant","Monstera":"Houseplant","Neanthe":"Houseplant","Nematanthus":"Houseplant",
  "Neoregelia":"Houseplant","Nephrolepis":"Houseplant","Olea":"Houseplant","Pachira":"Houseplant",
  "Pellaea":"Houseplant","Pellionia":"Houseplant","Phalaenopsis":"Houseplant","Phlebodium":"Houseplant",
  "Philodendron":"Houseplant","Pilea":"Houseplant","Platycerium":"Houseplant","Pleomele":"Houseplant",
  "Polyscias":"Houseplant","Polystichum":"Houseplant","Pothos":"Houseplant","Pteris":"Houseplant",
  "Rhaphidophora":"Houseplant","Saintpaulia":"Houseplant","Sansevieria":"Houseplant","Saxifraga":"Houseplant",
  "Schefflera":"Houseplant","Scindapsus":"Houseplant","Selaginella":"Houseplant","Soleirolia":"Houseplant",
  "Spathiphyllum":"Houseplant","Strelitzia":"Houseplant","Stromanthe":"Houseplant","Syngonium":"Houseplant",
  "Tillandsia":"Air Plant","Zamia":"Houseplant","Zamioculcas":"Houseplant","Zantedeschia":"Houseplant",
  "Aeschynanthus":"Houseplant","Coleus":"Houseplant","Aechmea":"Houseplant","Guzmania":"Houseplant",
  "Vriesea":"Houseplant","Cryptanthus":"Houseplant","Cyclamen":"Houseplant","Cussonia":"Houseplant"
};
function getType(genus){
  if (!genus || genus === "(no genus)") return "";
  return GENUS_TYPE[genus] || "";
}
