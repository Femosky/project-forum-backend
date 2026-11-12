// Launch communities and their starter threads, written late October 2026. Facts in the threads come from
// reporting at the time (INEC's timetable and candidate list, match results, TechCabal, NBS figures); keep them
// accurate and keep election threads neutral if you edit them.
//
// `ago` is how many hours before the seed runs a thread was posted. `up`/`down` are how many seed accounts vote on
// it. Comments are written with c(author, body, upvotes, replies).

export type SeedComment = { by: string; body: string; up: number; replies: SeedComment[] };
export type SeedThread = { by: string; ago: number; up: number; down?: number; title: string; body: string; comments: SeedComment[] };
export type SeedCommunity = {
    name: string;
    display_name: string;
    category: string;
    description: string;
    rules: { title: string; description: string }[];
    threads: SeedThread[];
};

const c = (by: string, body: string, up = 0, replies: SeedComment[] = []): SeedComment => ({ by, body, up, replies });

const BE_DECENT = { title: 'Be decent', description: 'Argue with the point, not the person. No insults, slurs or threats.' };
const NO_SPAM = { title: 'No spam or self-promotion', description: 'No referral links, giveaways or "DM me" posts. Mods remove them.' };

export const LAUNCH_COMMUNITIES: SeedCommunity[] = [
    {
        name: 'Elections2027',
        display_name: 'Elections 2027',
        category: 'other',
        description: "Nigeria's 2027 general elections: presidential and governorship candidates, INEC dates, voter registration and the issues on the ballot. Every side is welcome and claims need sources. Ask how to vote, check viral claims and compare the candidates' plans.",
        rules: [
            BE_DECENT,
            { title: 'Source your claims', description: 'Results, polls and quotes need a link to where they came from. No screenshots of "leaked" results.' },
            { title: 'No hate or ethnic attacks', description: 'Criticise candidates and policies all you want. Attacks on tribes or religions get removed.' },
            NO_SPAM,
        ],
        threads: [
            {
                by: 'seun_adeyemi',
                ago: 62,
                up: 27,
                title: 'Nigeria 2027 presidential election: which issue matters most to your vote?',
                body: `Premium Times ran the full list over the weekend. 18 candidates for January 16, and possibly 19 if the Accord candidate's court win gets added.

Forget the personalities for a second. If you could only judge them on one thing, what would it be? For me it's power supply. Every business I know is spending more on diesel and solar than on staff.`,
                comments: [
                    c('halima_b', 'Security, without question. Nothing else works if people cannot travel between states safely.', 14, [
                        c('emeka_n', "Same. And I want a plan with numbers, not 'we will tackle insecurity'. Everyone says that.", 6),
                    ]),
                    c('dayo_fin', 'Cost of living. Food inflation is still around 19.6% even with headline at 14.6%. That is the number people feel at the market.', 11, [
                        c('kunle_builds', 'This. Headline coming down is good news but my foodstuff list has not gotten the memo.', 5),
                    ]),
                    c('ifeoma_n', 'Education. ASUU strikes cost me almost a full year in school. I want to hear what anyone will do about funding universities properly.', 8),
                    c('gbenga_ola', 'Power for me too. You cannot industrialise on generators.', 4),
                    c('tunde_lag', "Honestly, I want to know who has a credible team. One person can't fix anything; show me who your ministers would be.", 7),
                ],
            },
            {
                by: 'ngozi_ek',
                ago: 140,
                up: 22,
                title: "When is Nigeria's 2027 presidential election? Dates and how to check your voter registration",
                body: `A lot of people in my family group chat still think the election is in February. INEC revised the timetable after the Electoral Act 2026 was signed:

- Presidential and National Assembly: Saturday, January 16, 2027
- Governorship and State Assembly: Saturday, February 6, 2027

If you moved since 2023, check your polling unit details on INEC's site before December. It's going to be very busy with people travelling for the holidays.`,
                comments: [
                    c('bisola_t', "Thanks for this. I genuinely didn't know it moved. That's right after New Year, so a lot of people who travel home for Christmas might still be in the village.", 9, [
                        c('ngozi_ek', "Exactly why I posted. If you registered in your hometown that might actually work in your favour, if you registered in Lagos and you're in Enugu for the holidays, plan ahead.", 6),
                    ]),
                    c('musa_dan', 'Checked mine this morning, took two minutes. Do it now and stop telling yourself you will do it later.', 7),
                    c('precious_u', 'Is there still a way to transfer polling unit or is that window closed?', 2, [
                        c('ruth_ab', "I'm not sure about the current deadline. Best to check INEC's official site or their X account directly rather than trusting WhatsApp broadcasts.", 4),
                    ]),
                ],
            },
            {
                by: 'jide_o',
                ago: 95,
                up: 18,
                down: 2,
                title: 'Do running mates change how Nigerians vote in presidential elections?',
                body: `Shettima again for Tinubu, Amaechi with Atiku, and Kwankwaso on Obi's ticket according to the list. Each one is clearly about a particular region or base.

Do running mates actually move votes in Nigeria, or does everyone just vote for the top of the ticket?`,
                comments: [
                    c('sadiq_a', "In the North they matter more than people in Lagos think. A running mate with a real grassroots network can deliver turnout, which is what actually counts.", 10),
                    c('adaeze_o', "I think they matter for the coalition behind the scenes more than for the average voter. Most people I know couldn't name the 2019 running mates.", 8, [
                        c('jide_o', 'Fair point. Turnout operation vs voter preference are different things.', 3),
                    ]),
                    c('chuka_r', 'It also tells you who the candidate thinks they need. That is useful information on its own.', 5),
                ],
            },
            {
                by: 'ruth_ab',
                ago: 30,
                up: 15,
                title: 'Election fact-check: how to verify viral claims and videos before you share them',
                body: `Campaign season means fake quotes, old videos with new captions and "results" months before anyone votes.

If you see something in a group chat and you're not sure, post it here. Others can help find where it came from. Please don't repost the thing itself as if it's true, describe it.`,
                comments: [
                    c('temi_reads', "Good idea. Tip for everyone: reverse image search catches half of these. Most of the 'rally crowd' photos going round are from years ago.", 9),
                    c('yusuf_k', 'There is a clip going around of a candidate supposedly saying he will scrap NYSC. Anyone seen the full speech?', 4, [
                        c('ruth_ab', "I've looked and can't find it in any full recording or credible outlet. Until someone does, treat it as unverified.", 6),
                    ]),
                ],
            },
        ],
    },
    {
        name: 'BBNaija',
        display_name: 'Big Brother Naija',
        category: 'entertainment',
        description: 'Big Brother Naija discussion: housemates, evictions, weekly highlights and life after the show. Talk about the latest season, past winners and what former housemates are doing now.',
        rules: [
            BE_DECENT,
            { title: 'No leaking private information', description: "Housemates' and ex-housemates' private details, addresses and family members are off limits." },
            { title: 'Label spoilers', description: 'Put "spoiler" in the title if you are discussing an episode before it has aired everywhere.' },
            NO_SPAM,
        ],
        threads: [
            {
                by: 'kemi_o',
                ago: 200,
                up: 25,
                title: 'Was Temi Nkem the right winner of BBNaija Season 11?',
                body: `Now that everyone has calmed down a bit. I was on Team Sheba for most of the season and I was disappointed on finale night, but rewatching some of the clips, I get why Temi won. She never really had a bad week.

Was it the right result for you?`,
                comments: [
                    c('folake_b', 'Yes. She was consistent and she never had to create drama to stay relevant. That is rare on this show.', 13, [
                        c('lola_k', 'Consistent is the word. Some people peaked in week three and spent the rest of the season trying to get it back.', 6),
                    ]),
                    c('efe_jays', 'Aikou deserved more credit. Entertained us the whole season and still finished top three.', 9),
                    c('chiomaa', "Honestly the three finalists were all fair. My issue is with some of the people who got evicted early. The voting is so tied to fanbases now.", 7, [
                        c('kemi_o', 'The fanbase wars are a whole other show at this point.', 4),
                    ]),
                    c('timi_w', "Season 11 having two disqualifications AND a voluntary exit is wild. First season with all three, apparently.", 8),
                ],
            },
            {
                by: 'lola_k',
                ago: 75,
                up: 14,
                title: 'Which BBNaija Season 11 housemates will have the biggest careers after the show?',
                body: 'Winning is one thing, but some of the biggest names from past seasons never won. Who from this season do you think brands and producers will be chasing by this time next year?',
                comments: [
                    c('kemi_o', 'Temi obviously has the momentum, but the person with a skill outside the show will last longest. Watch who gets an acting role first.', 7),
                    c('bisola_t', 'The ones who already had a following before the house always do better after. The show just amplifies what you had.', 5),
                    c('efe_jays', 'Aikou. Comedy travels and he already has the timing.', 6),
                ],
            },
            {
                by: 'chiomaa',
                ago: 30,
                up: 11,
                title: 'Should Big Brother Naija seasons be shorter than ten weeks?',
                body: "Ten weeks is a long time to keep up with the show every night. By week seven, I'm only watching the highlights on X. Would you watch more if it were six or eight weeks?",
                comments: [
                    c('folake_b', "Shorter, please. The middle weeks drag and that's when the forced drama starts.", 5),
                    c('timi_w', 'The long run is what builds the fanbases though, and the fanbases are what make the money for the show. I doubt they will change it.', 6, [
                        c('chiomaa', 'True, the business side wins every time.', 2),
                    ]),
                ],
            },
        ],
    },
    {
        name: 'SuperEagles',
        display_name: 'Super Eagles',
        category: 'sports',
        description: 'Nigeria national football team news and discussion: the Super Eagles, the Super Falcons and Nigerian players abroad. Match threads, AFCON and World Cup qualifiers, squad lists and debate about the coach.',
        rules: [BE_DECENT, { title: 'No betting tips', description: 'Odds, betting codes and tipster links are removed.' }, NO_SPAM],
        threads: [
            {
                by: 'obinna_fc',
                ago: 170,
                up: 31,
                down: 2,
                title: 'Super Eagles lost 3-0 to Guinea-Bissau: what went wrong and what needs to change?',
                body: `Beat Madagascar 2-1 in Uyo with two debutants scoring, everyone was happy. Then four days later Guinea-Bissau put three past us and it could have been more.

I don't think it's one thing. Midfield got overrun, the full-backs were caught high all game, and we had no plan B once we went behind. Tanzania home and away in November now feels like must-win.`,
                comments: [
                    c('bayo_kicks', "The midfield issue has been there for years. We have talent up front and at the back and nobody who can control a game in the middle.", 16, [
                        c('obinna_fc', 'Yep. We play like a team of very good individuals.', 7),
                        c('nnamdi_m', 'Give the young boys a run. Usor showed something against Madagascar.', 5),
                    ]),
                    c('gbenga_ola', 'Playing away in that heat on a short turnaround after travel is tough, but Guinea-Bissau did it too. No excuses.', 9),
                    c('ahmed_ib', 'Chelle needs to settle on a system. Every camp looks like a new experiment.', 11, [
                        c('bayo_kicks', "To be fair he's also dealing with injuries every international break. Osimhen was barely fit in September.", 4),
                    ]),
                    c('emeka_n', "After missing the World Cup, the AFCON is the bare minimum. If we don't get out of this group, people will want answers.", 8),
                ],
            },
            {
                by: 'nnamdi_m',
                ago: 115,
                up: 19,
                title: 'Should Ilenikhena and Usor start for the Super Eagles against Tanzania?',
                body: "Both scored on their first senior caps against Madagascar. I'd like to see them start in November rather than coming on with ten minutes left. Too early, or is this exactly the time?",
                comments: [
                    c('obinna_fc', 'Start at least one of them at home. Away, go with experience.', 8),
                    c('timi_w', "Ilenikhena's movement for that goal was brilliant. Iwobi's pass helped, but the run was all him.", 7),
                    c('bayo_kicks', 'One good game is one good game. But the old guard didn\'t exactly earn their places in Bissau either.', 9),
                ],
            },
            {
                by: 'bayo_kicks',
                ago: 44,
                up: 12,
                title: 'Nigerian footballers abroad: how did they play this weekend?',
                body: "Fulham won 1-0 at Coventry with Bassey and Iwobi both involved, and Iheanacho is still scoring in Turkey. Who else had a good weekend? Add the ones I've missed.",
                comments: [
                    c('ahmed_ib', 'Arokodare is in good form too. He should be in the conversation for November.', 6),
                    c('nnamdi_m', 'Iheanacho is quietly having a very good spell. Not sure he gets back in the qualifiers squad, but he is making it hard to ignore him.', 5),
                ],
            },
        ],
    },
    {
        name: 'PremierLeague',
        display_name: 'Premier League',
        category: 'sports',
        description: 'English Premier League discussion for fans everywhere: match threads, the title race, transfers and tactics. Friendly rivalry is welcome, abuse is not.',
        rules: [BE_DECENT, { title: 'Friendly banter only', description: 'Rivalry is fine. Abuse of players or other users is not.' }, NO_SPAM],
        threads: [
            {
                by: 'tunde_lag',
                ago: 128,
                up: 23,
                down: 3,
                title: 'Premier League title race 2026/27: can anyone catch Man City and Arsenal?',
                body: "Seven games in and City are on 21 points, Arsenal on 18, Brighton sitting third. It's early, but it already feels like a two-horse race. Who's staying in it until May?",
                comments: [
                    c('obinna_fc', "Arsenal fan here. I've seen this movie before and I'm not getting excited until March.", 14, [
                        c('tunde_lag', 'The trauma is real lol', 6),
                    ]),
                    c('chuka_r', 'Brighton are the story. Nobody is talking about them enough.', 9),
                    c('jide_o', "City's appeal against the 114 charges verdict hangs over all of it. Points deductions would make this table meaningless.", 11, [
                        c('ahmed_ib', "Until there's a final decision, the table is the table. I'm not doing hypotheticals.", 5),
                    ]),
                    c('gbenga_ola', 'Chelsea are lurking. Four points off with a young squad that is still learning.', 4),
                ],
            },
            {
                by: 'timi_w',
                ago: 20,
                up: 13,
                title: "Bukayo Saka wins the Sócrates Award at the Ballon d'Or, presented by Burna Boy",
                body: 'Burna Boy handed the Sócrates Award to Bukayo Saka at the Ballon d\'Or in London last night. First Nigerian artist to present an award there, apparently. Nice moment, and a deserved award for Saka\'s work off the pitch.',
                comments: [
                    c('kunle_builds', "Saka's charity work doesn't get enough coverage. Glad it got recognised.", 8),
                    c('efe_jays', 'Burna at the Ballon d\'Or is such a sign of how far the music has travelled.', 7, [
                        c('timi_w', 'Ten years ago nobody would have believed it.', 3),
                    ]),
                ],
            },
            {
                by: 'ahmed_ib',
                ago: 60,
                up: 9,
                title: 'Where to watch Premier League matches in Lagos without a DStv subscription',
                body: 'My subscription ran out and I refuse to renew at these prices just for football. Viewing centres, bars, apps? Looking for somewhere around Yaba or Surulere with a decent screen and not too rowdy.',
                comments: [
                    c('tunde_lag', 'Most of the lounges around Herbert Macaulay show the big games. Go early for the 5:30 kickoffs.', 4),
                    c('bisola_t', 'Split a subscription with neighbours. Four flats on one decoder is how my compound survives.', 6),
                ],
            },
        ],
    },
    {
        name: 'Afrobeats',
        display_name: 'Afrobeats',
        category: 'entertainment',
        description: 'Afrobeats, Afropop, Amapiano and alté: new releases, albums, concerts and the artists behind them. Share playlists, debate rankings and follow the business of Nigerian music.',
        rules: [BE_DECENT, { title: 'No piracy links', description: 'Share streaming links or videos, not downloads.' }, NO_SPAM],
        threads: [
            {
                by: 'efe_jays',
                ago: 52,
                up: 21,
                title: 'Should Afrobeats artists speak out about politics before the 2027 election?',
                body: `There is an op-ed going round arguing against the idea that labels keep Afrobeats apolitical. It points out Wizkid and Davido were both on Sony when they backed EndSARS, and that Burna Boy's "Monsters You Made" came out on Warner.

With the election in January, do you expect any of the big names to say anything? Should they?`,
                comments: [
                    c('temi_reads', 'They are entertainers, not politicians. Their fans cover every party. Speaking up is a business risk, and I understand why they avoid it.', 9, [
                        c('efe_jays', "But Fela built a whole legacy on not avoiding it. That's literally where the genre comes from.", 11),
                    ]),
                    c('kemi_o', "I'd rather they encourage people to register and vote than endorse anyone.", 10),
                    c('adaeze_o', 'Burna has always been more political in his music than people give him credit for. Listen to the lyrics, not the interviews.', 6),
                ],
            },
            {
                by: 'temi_reads',
                ago: 150,
                up: 17,
                title: 'Wizkid, Davido or Burna Boy: who has had the best year in 2026?',
                body: "It's been a big year for all three, with festival slots abroad and the AMA nominations. If you had to rank them on this year alone, not their careers, how does it go?",
                comments: [
                    c('chuka_r', "Burna for this year. The Ballon d'Or appearance alone shows how far his name travels.", 7),
                    c('lola_k', "Rema should be in this conversation now. 'Big three' is an outdated idea.", 13, [
                        c('temi_reads', 'Okay, fair. Big four then.', 5),
                        c('efe_jays', 'Tems too. She is on a different level internationally.', 8),
                    ]),
                    c('folake_b', 'Davido for live shows. Nobody in Nigeria performs like him.', 6),
                ],
            },
            {
                by: 'chuka_r',
                ago: 26,
                up: 10,
                title: 'Best Afrobeats and highlife songs for a December family party playlist',
                body: "Making a playlist for a family party in December. I need songs that work for my parents' generation and my cousins at the same time. Give me your safest picks.",
                comments: [
                    c('amaka_eats', 'Anything Flavour. Works on every age group without fail.', 7),
                    c('dami_codes', "2Baba's 'African Queen' at some point is mandatory. The uncles will thank you.", 9),
                    c('adaeze_o', "Throw in some old highlife early in the night and save the amapiano for after the food.", 5),
                ],
            },
        ],
    },
    {
        name: 'Japa',
        display_name: 'Japa',
        category: 'relocation',
        description: 'Practical help with relocating abroad from Nigeria: visas, study and work routes to the UK, Canada, the US and Europe, the real costs and settling in. Ask questions, share what worked and link official sources, because the rules change often.',
        rules: [
            BE_DECENT,
            { title: 'No visa agents or "guaranteed" offers', description: 'Posts offering paid visa help, job placements or proof-of-funds services are removed.' },
            { title: 'Say where your information comes from', description: 'Rules change often. Link the official page when you can.' },
            NO_SPAM,
        ],
        threads: [
            {
                by: 'uche_dev',
                ago: 110,
                up: 28,
                title: "UK Graduate Route changes in January 2027: is a UK master's still worth it for Nigerians?",
                body: `From 1 January 2027 the Graduate Route is changing for most graduates, and the English requirement for Skilled Worker went up to B2 in January this year. Most sponsored roles have also had to be degree level since last year.

I'm deciding between a UK master's next September or staying here and applying for remote roles. For those who went recently, would you still do it with these rules?`,
                comments: [
                    c('adaeze_o', 'I went in 2024. The degree itself was fine, but the job market after was much harder than anyone told me. Do it only if your field actually sponsors.', 15, [
                        c('uche_dev', "That's my worry. I'm in software, and sponsorship has dried up a lot.", 6),
                        c('nnamdi_m', 'Software is tough right now. Healthcare and some engineering roles are still sponsoring.', 5),
                    ]),
                    c('halima_b', 'Calculate the full cost in naira at today\'s rate before you decide. Tuition plus living costs for a year is serious money.', 12),
                    c('dami_codes', 'If you are getting remote offers already, a master\'s abroad is a very expensive way to end up doing the same job.', 9),
                    c('ese_ok', "Check the official GOV.UK pages for the exact Graduate Route change. I've seen three different versions on social media.", 7),
                ],
            },
            {
                by: 'precious_u',
                ago: 48,
                up: 16,
                title: 'Canada study permit processing time for Nigeria is now 10 weeks',
                body: "IRCC moved Nigeria from 9 to 10 weeks for study permits. If you're aiming for January intake and haven't applied, it's going to be very tight. Anyone else waiting right now?",
                comments: [
                    c('ruth_ab', 'Applied in August, still waiting. The posted times are an average, mine is already past it.', 6),
                    c('folake_b', 'Also worth knowing: if you are already on a work permit you can now take short courses up to six months without a separate study permit. Helped my sister.', 9),
                    c('precious_u', 'Good to know. I did not know about the six-month rule.', 2),
                ],
            },
            {
                by: 'gbenga_ola',
                ago: 210,
                up: 22,
                title: 'Moving to Toronto from Nigeria: what I wish I knew before relocating',
                body: `Not trying to scare anyone, just being honest.

1. Your first job will probably not be in your field. Budget for that.
2. Winter is not a joke. Buy proper boots once instead of cheap ones three times.
3. Rent eats everything. A room in a shared house is normal for the first year.
4. Credit history starts at zero. Get a secured card in your first month.
5. Loneliness hits around month four. Find a church, mosque, team, anything.

Would I do it again? Yes. But I would have come with more savings.`,
                comments: [
                    c('seun_adeyemi', 'Number 5 is the one nobody talks about. Thank you for saying it.', 13),
                    c('halima_b', 'How much would you say is enough savings for the first six months?', 4, [
                        c('gbenga_ola', "Depends on the city, but I'd want at least six months of rent and food without a job. Then you are not desperate in interviews.", 8),
                    ]),
                    c('kemi_o', "The credit history one caught me out in the UK too. Nobody tells you until you try to get a phone contract.", 6),
                ],
            },
            {
                by: 'tunde_lag',
                ago: 18,
                up: 9,
                title: 'Why some Nigerians choose not to relocate abroad',
                body: "Everyone in my team has either left or is in the process. I have options, but I'm leaning towards staying. My family is here and my business is finally growing. Would love to hear from people who chose not to go.",
                comments: [
                    c('kunle_builds', 'I stayed. Earning in dollars remotely and spending in naira has been better for my family than moving would have been. It is not for everyone, but it is an option.', 10),
                    c('ifeoma_n', "I came back after three years. Not a failure story; I just preferred my life here. People don't hear that version often.", 8),
                ],
            },
        ],
    },
    {
        name: 'LagosRent',
        display_name: 'Lagos Rent',
        category: 'housing',
        description: 'Renting in Lagos: rent prices by area, agency and legal fees, landlords, tenancy law and house-hunting tips. Compare what other tenants pay and know your rights before you pay.',
        rules: [
            BE_DECENT,
            { title: 'No listings from agents', description: 'Tenants sharing a vacancy is fine. Agent adverts and fee requests are removed.' },
            { title: "Don't post people's addresses", description: 'Name the area, not the house.' },
        ],
        threads: [
            {
                by: 'funmi_a',
                ago: 88,
                up: 26,
                title: 'Lagos tenancy bill: will a 5% cap on agency fees help tenants?',
                body: `For anyone who missed it: the Lagos Tenancy and Recovery of Premises Bill is still going through the House of Assembly. It's not law yet. The draft would cap agent commission at 5% of a year's rent, so ₦100k on a ₦2m flat instead of the 10 to 20% people are charged now.

The 2011 law is what applies today, and agents have to be registered with LASRERA. But who actually checks?`,
                comments: [
                    c('tunde_lag', 'The 2011 law already had limits and everyone ignored them. Without enforcement, a new number on paper changes nothing.', 15, [
                        c('funmi_a', 'Agreed, but at least a tenant would have something clear to point to. Right now it is just your word against the agent.', 7),
                    ]),
                    c('bisola_t', "Ask every agent for their LASRERA registration before you pay anything. A couple of them disappeared on me when I asked. That told me everything.", 12),
                    c('yusuf_k', 'Landlords will just add it to the rent. The money has to come from somewhere.', 8, [
                        c('ngozi_ek', "Maybe, but at least it's then a yearly cost you can negotiate, not a one-off fee you lose.", 4),
                    ]),
                ],
            },
            {
                by: 'kunle_builds',
                ago: 160,
                up: 19,
                title: 'How much is rent for a mini flat in Lagos now? Prices by area',
                body: 'Trying to see if my landlord is being reasonable. I pay ₦2.4m a year for a mini flat in Yaba, and he wants ₦3m at renewal. Share your area and rent so we can all compare.',
                comments: [
                    c('folake_b', 'Mini flat in Gbagada, ₦2.2m. Renewed in June, he wanted more but settled at the same price because I pay on time.', 8),
                    c('emeka_n', 'Self-contained in Ikorodu, ₦750k. The commute costs me almost as much as the rent though.', 10, [
                        c('kunle_builds', 'This is the trap. Cheaper rent, but you pay in fuel and time.', 6),
                    ]),
                    c('chiomaa', 'Mini flat in Lekki Phase 1 is ₦5m+ now. I moved to Ajah for ₦2.8m.', 7),
                    c('dami_codes', 'Ask for the increase in writing and offer a two-year deal at a middle price. Worked for me.', 9),
                ],
            },
            {
                by: 'bisola_t',
                ago: 36,
                up: 13,
                title: 'What to check before you pay rent for an apartment in Lagos',
                body: `Learned some of these the hard way:

- See the landlord or a letter from them, not just the agent
- Check water pressure in the bathroom, not only the kitchen
- Ask the neighbours how often there's light
- Check what "service charge" covers in writing
- Never pay into an individual's account without a receipt and agreement

What would you add?`,
                comments: [
                    c('ngozi_ek', 'Visit at night once. Some streets feel completely different after 8pm.', 9),
                    c('musa_dan', 'Check if the road floods. Come back after a heavy rain if you can.', 8),
                    c('funmi_a', 'Read the tenancy agreement for how much notice they need to give you. Some are shockingly short.', 5),
                ],
            },
        ],
    },
    {
        name: 'Tech',
        display_name: 'Tech',
        category: 'tech',
        description: 'Nigerian tech news and discussion: startups, funding, fintech, layoffs, policy and the people building products in Nigeria and across Africa. Share news with a source and ask builders what they think.',
        rules: [BE_DECENT, { title: 'No crypto shilling', description: 'Discussing crypto is fine. Promoting tokens, signals or schemes is not.' }, NO_SPAM],
        threads: [
            {
                by: 'dami_codes',
                ago: 34,
                up: 24,
                title: 'Moniepoint offers engineers and product staff a voluntary exit: what it means',
                body: `TechCabal reported that Moniepoint told staff on October 19 about a restructuring across backend, frontend, mobile, QA and product, moving to smaller teams that own products end to end. People who leave get five months' salary. No number on how many roles are affected.

Five months is generous compared with what we usually see here. But it's another sign that 2026 is the year of "do more with fewer people".`,
                comments: [
                    c('uche_dev', 'Five months is honestly decent. A lot of startups give one month and an apology email.', 12),
                    c('kunle_builds', "'Smaller teams that own products end to end' usually means AI tools are doing some of what juniors did. Hard time to be entry level.", 14, [
                        c('dami_codes', 'That is my read too. The bar for junior roles has gone way up.', 6),
                        c('ifeoma_n', "Or it's just a normal reorg. Not everything is AI.", 5),
                    ]),
                    c('chuka_r', 'If you are affected and you were thinking about building something, five months of runway is not bad.', 7),
                ],
            },
            {
                by: 'kunle_builds',
                ago: 300,
                up: 17,
                title: 'African startup funding hit $2.49B in nine months, with Nigeria top at $624M',
                body: "From TechCabal's Q3 numbers. Up about 8% year on year, with Q3 a rebound. Nigeria is still number one, but the number of small pre-seed deals has dropped a lot. Is it getting easier or harder to raise here?",
                comments: [
                    c('seun_adeyemi', 'Easier if you already have revenue. Much harder if you have only a deck. Most of the money is going to later rounds.', 9),
                    c('nnamdi_m', 'Deals between $100k and $1m dropped by almost half according to Africa: The Big Deal. That is the stage most founders here are at.', 8),
                    c('dami_codes', "Bootstrapping is underrated. Customers are the cheapest investors.", 6),
                ],
            },
            {
                by: 'nnamdi_m',
                ago: 70,
                up: 11,
                title: 'Will $1bn of new data centres make cloud hosting cheaper in Nigeria?',
                body: "TechCabal had the story this week. More local capacity should help with latency and data rules, but power is the real cost for any data centre in Nigeria. Will we see local pricing that's actually competitive?",
                comments: [
                    c('uche_dev', 'Only if they can sort power without running everything on diesel. Otherwise it gets passed to customers.', 7),
                    c('gbenga_ola', 'Data residency for banks and government is the real market. Startups will still use AWS and GCP.', 6),
                ],
            },
        ],
    },
    {
        name: 'TechCareers',
        display_name: 'Tech Careers',
        category: 'careers',
        description: 'Career advice for tech jobs in Nigeria and remote roles abroad: getting a first job, switching careers, CVs, interviews and developer salaries. Share what you earn and what worked for you.',
        rules: [BE_DECENT, { title: 'No paid course promotion', description: 'Recommending a free resource is fine. Selling your bootcamp is not.' }, NO_SPAM],
        threads: [
            {
                by: 'ifeoma_n',
                ago: 82,
                up: 20,
                title: 'How much do mid-level software developers earn in Lagos?',
                body: "I'm about to negotiate an offer and I don't know what's normal anymore. Three years' experience, backend. Local company offering ₦850k a month. Is that low? Remote roles pay in dollars, but I'm not getting callbacks.",
                comments: [
                    c('uche_dev', "₦850k for three years backend is around the middle for local companies, maybe slightly low for fintech. Ask for ₦1.1m and settle around ₦1m.", 11),
                    c('dami_codes', 'Ask about the HMO, pension and whether they pay for power or internet if it is hybrid. Those add up.', 9),
                    c('seun_adeyemi', "On remote: tailor your CV per role and put measurable results at the top. 'Built X that did Y' gets callbacks.", 8, [
                        c('ifeoma_n', 'Thank you, I think my CV is too much of a list of tools.', 3),
                    ]),
                ],
            },
            {
                by: 'zainab_m',
                ago: 140,
                up: 16,
                title: 'Is 31 too late to switch careers from accounting to data analysis?',
                body: 'Eight years in audit, and I want out. I have been learning SQL and Power BI in the evenings. Is 31 too late to start as a junior, and should I take a pay cut for it?',
                comments: [
                    c('halima_b', "Not too late at all. Your audit background is an advantage; you already understand the data most analysts are trying to learn about.", 12),
                    c('kunle_builds', "Don't go to junior. Look for finance analytics roles where your experience counts. Same field, new skills.", 10),
                    c('ese_ok', 'I did almost exactly this at 33. Took about a year. No regrets.', 7),
                ],
            },
            {
                by: 'uche_dev',
                ago: 22,
                up: 8,
                title: 'How to handle late-night interviews with US companies when you work from Nigeria',
                body: 'Got a final round with a US company and the only slots are 9am Pacific, which is 5pm here. That one is fine, but the previous round was at 1am. Anyone else just push back on times?',
                comments: [
                    c('dami_codes', "Always ask. Most recruiters don't think about time zones until you mention it.", 6),
                    c('temi_reads', 'Asking also tells you a bit about how they will treat timezone differences when you work there.', 5),
                ],
            },
        ],
    },
    {
        name: 'MoneyMatters',
        display_name: 'Money Matters',
        category: 'money',
        description: 'Personal finance in Nigeria: saving, budgeting, investing, banking, inflation and the cost of living. Practical answers from people managing money in naira, with no get-rich-quick schemes.',
        rules: [
            BE_DECENT,
            { title: 'No investment schemes', description: 'Ponzi, "double your money", signals and forex groups are removed and the poster banned.' },
            { title: 'Not financial advice', description: 'Share experience and sources. Do your own research before you put money anywhere.' },
        ],
        threads: [
            {
                by: 'dayo_fin',
                ago: 120,
                up: 23,
                title: "Nigeria's inflation fell to 14.63% in September. Why are prices still rising?",
                body: `NBS says headline inflation dropped to 14.63%, the lowest since 2020. Food inflation is still at 19.59%, and petrol is around ₦1,350 to ₦1,400 a litre depending on where you are.

A lower inflation rate means prices are rising more slowly. It doesn't mean they're falling. I think that's why nobody believes the headline number.`,
                comments: [
                    c('halima_b', 'Exactly. Prices went up 30% and are now going up 15%. My salary went up 0%.', 15, [
                        c('dayo_fin', 'Real wages are the story nobody puts in the headline.', 6),
                    ]),
                    c('yusuf_k', 'Also the base effect after the rebasing makes year-on-year comparisons tricky. Look at month-on-month too.', 7),
                    c('funmi_a', "The naira has been steady around ₦1,330 to the dollar for weeks, which helps a bit. Imported stuff isn't jumping like last year.", 8),
                ],
            },
            {
                by: 'halima_b',
                ago: 64,
                up: 17,
                title: 'Where to keep savings in Nigeria: money market funds, treasury bills or dollars?',
                body: "I have about ₦1.5m in a regular savings account doing nothing. What are people actually using that isn't risky? Not looking for anything fancy, just to keep up with inflation if possible.",
                comments: [
                    c('dayo_fin', 'Money market funds from the big asset managers are a reasonable starting point. You can withdraw in a few days and the returns are much better than a savings account.', 10),
                    c('sadiq_a', 'T-bills if you won\'t need it for a while. Check the latest auction rates on the CBN site.', 7),
                    c('kemi_o', 'Keep an emergency fund you can reach immediately before you lock anything up.', 9),
                    c('ese_ok', "Whatever you do, only use platforms regulated by SEC. If it promises fixed high returns, run.", 11),
                ],
            },
            {
                by: 'musa_dan',
                ago: 28,
                up: 12,
                title: 'How to cut transport costs in Lagos with petrol at about ₦1,355 a litre',
                body: "I drive about 30km each way, three days a week, and fuel is now one of my biggest expenses. I've started carpooling twice a week. What else are people doing?",
                comments: [
                    c('tunde_lag', 'Negotiated two remote days with my manager. Saves me more than any other trick.', 8),
                    c('gbenga_ola', 'The Blue Line has saved me a lot on the island routes. Not for everyone, but check if it works for your route.', 6),
                    c('amaka_eats', "Combining errands into one trip. Sounds small, but it adds up over a month.", 4),
                ],
            },
        ],
    },
    {
        name: 'SmallBusiness',
        display_name: 'Small Business',
        category: 'business',
        description: 'Help for small business owners in Nigeria: CAC registration, customers and payments, suppliers, power and solar costs, and growing the business. Ask questions and share what worked for you.',
        rules: [BE_DECENT, { title: 'One promo post a month', description: 'You may share your own business once a month in a post that clearly says so.' }, NO_SPAM],
        threads: [
            {
                by: 'amaka_eats',
                ago: 96,
                up: 18,
                title: 'Is solar worth it for a small business in Nigeria compared with a diesel generator?',
                body: "I run a small bakery in Surulere. The ovens are gas, but the fridge, mixers and lights run on generator for most of the day. I've been quoted around ₦4.5m for a solar and battery setup. Has anyone done this and actually saved money?",
                comments: [
                    c('chuka_r', "Did it for my shop last year. It paid for itself in about 18 months. Get the battery size right, that's where installers cut corners.", 11, [
                        c('amaka_eats', 'How do you know the battery size is right?', 2),
                        c('chuka_r', 'Add up the watts of everything you run and the hours. Get two installers to quote separately and compare their numbers.', 7),
                    ]),
                    c('gbenga_ola', 'Solar for the light load, keep the generator for the heavy stuff. Running mixers on solar needs a big inverter.', 8),
                    c('zainab_m', 'Ask about warranty in writing and who services it. A lot of installers disappear after six months.', 6),
                ],
            },
            {
                by: 'folake_b',
                ago: 180,
                up: 14,
                title: 'Should a one-person business register with CAC in Nigeria?',
                body: "I sell skincare on Instagram. It's going well, and some bigger customers are asking for invoices from a registered business. Is CAC registration worth the time and cost at this stage?",
                comments: [
                    c('ese_ok', 'Yes. It takes a few weeks online, and it lets you open a business account. Customers trust you more.', 9),
                    c('seun_adeyemi', 'A business name registration is cheap and enough for now. Go limited company when you hire or take investment.', 8),
                ],
            },
            {
                by: 'yusuf_k',
                ago: 40,
                up: 10,
                title: "How to handle pay on delivery when customers don't pick up their orders",
                body: "About 40% of my orders want pay on delivery, and a lot of them don't pick up when the rider arrives. I lose the delivery fee every time. Do you just stop offering it?",
                comments: [
                    c('folake_b', 'Ask for the delivery fee upfront and the rest on delivery. The people who are serious will pay.', 10),
                    c('amaka_eats', 'POD only for repeat customers. New customers pay first.', 6),
                ],
            },
        ],
    },
    {
        name: 'Food',
        display_name: 'Food',
        category: 'food',
        description: 'Nigerian food: recipes, cooking tips, restaurants, street food and market prices across the country. Share where to eat and how to cook it, and settle the jollof debate.',
        rules: [BE_DECENT, NO_SPAM],
        threads: [
            {
                by: 'amaka_eats',
                ago: 54,
                up: 20,
                title: 'Nigerian food prices this month: what has gone down and what is still expensive?',
                body: "Tomatoes are finally reasonable in my market, and rice has eased a bit, but beans and meat are still painful. What are you seeing where you are?",
                comments: [
                    c('ngozi_ek', 'Garri has come down a little here in Enugu. Oil is still expensive.', 7),
                    c('musa_dan', 'In Kano, tomatoes are cheap right now, it is the season. Onions too.', 9),
                    c('lola_k', 'Chicken in Lagos is still ridiculous. I buy a whole one and portion it now.', 6),
                    c('dayo_fin', 'Food inflation in the September numbers was still about 19.6%. So yes, it is still rising, just more slowly.', 5),
                ],
            },
            {
                by: 'ibk_writes',
                ago: 230,
                up: 25,
                down: 3,
                title: 'Party jollof vs home jollof: which one is better?',
                body: "It's the firewood, the big pot and the bottom of the pot. You can't recreate it in a home kitchen, and I'll die on this hill.",
                comments: [
                    c('adaeze_o', 'Party jollof is a whole genre on its own. Not better, just different.', 12),
                    c('amaka_eats', 'You can get close at home with a heavy pot and letting it burn slightly at the end. The smoke is the secret.', 10, [
                        c('ibk_writes', 'Okay but that is just admitting party jollof is the standard.', 8),
                    ]),
                    c('zainab_m', 'Home jollof with fried plantain and good chicken beats all of it. I said what I said.', 9),
                ],
            },
            {
                by: 'lola_k',
                ago: 14,
                up: 8,
                title: 'Where to find the best suya in Abuja',
                body: "Going to be in Abuja for work for three days. Where is the best suya? Not the hotel kind, the proper stuff.",
                comments: [
                    c('sadiq_a', 'Go out at night around Wuse, you will smell the good ones before you see them. Ask for extra yaji.', 6),
                    c('ahmed_ib', 'Try the kilishi as well while you are there.', 4),
                ],
            },
        ],
    },
    {
        name: 'StudyAbroad',
        display_name: 'Study Abroad',
        category: 'education',
        description: 'Studying abroad from Nigeria: admissions, scholarships, student visas, proof of funds and student life in the UK, Canada, the US and beyond. Ask questions and share what worked, with links to official pages.',
        rules: [BE_DECENT, { title: 'No paid admission agents', description: 'Advice is free here. Posts selling admission or visa services are removed.' }, NO_SPAM],
        threads: [
            {
                by: 'temi_reads',
                ago: 100,
                up: 19,
                title: 'Scholarship deadlines for Nigerian students: Chevening, Commonwealth and more',
                body: "Chevening and a few others close in the next few weeks. Let's put the deadlines in one place. Please include a link to the official page, not a blog.",
                comments: [
                    c('ifeoma_n', 'Applying for Chevening. The essays take much longer than you think. Start now if you have not.', 10),
                    c('precious_u', 'Commonwealth Scholarships are worth a look too, especially for STEM.', 6),
                    c('zainab_m', 'Check the university\'s own scholarships. A lot of people only apply to the big ones and miss these.', 8),
                ],
            },
            {
                by: 'ese_ok',
                ago: 46,
                up: 12,
                title: 'How to show proof of funds for a student visa from Nigeria',
                body: "Admission is sorted, and now I need to show the funds. My family can help, but not all at once. How did you handle it without doing anything risky?",
                comments: [
                    c('halima_b', 'Start saving into one account early. Embassies want to see the money has been there for a while, not one big deposit last week.', 9),
                    c('ruth_ab', 'Please never use anyone offering to "provide" proof of funds. It gets people refused and banned.', 11),
                ],
            },
        ],
    },
    {
        name: 'Relationships',
        display_name: 'Relationships',
        category: 'relationships',
        description: 'Relationship advice and discussion: dating, marriage, family, introductions, weddings and friendships. Ask for advice, share your story and be kind.',
        rules: [
            BE_DECENT,
            { title: 'Protect privacy', description: 'No names, photos or details that could identify the people in your story.' },
            NO_SPAM,
        ],
        threads: [
            {
                by: 'bisola_t',
                ago: 76,
                up: 21,
                title: 'My partner wants to relocate abroad and I want to stay. How do couples handle this?',
                body: "We've been together four years. He has a job offer abroad, and I have a career I've built here and my mum, who isn't well. Neither of us wants to break up. Has anyone made long distance work, or found another way?",
                comments: [
                    c('gbenga_ola', 'My wife and I did a year apart. It works if there is a clear end date. Open-ended long distance is where it falls apart.', 13),
                    c('halima_b', 'Talk about a timeline for your mum too. Is there a point where moving would work for you, or not at all? He needs to know that.', 9),
                    c('kemi_o', 'Go visit for a few weeks before deciding anything. Some people hate it once they see it, some people love it.', 7),
                ],
            },
            {
                by: 'jide_o',
                ago: 132,
                up: 15,
                title: 'How much does a Nigerian introduction ceremony cost now?',
                body: "Our introduction is in December. Between the list from her family, food, drinks and travel, we're already over ₦3m and we haven't even started on the wedding. Is this normal?",
                comments: [
                    c('ngozi_ek', 'Normal, unfortunately. Sit down with both families and agree on what is required vs what is nice to have.', 9),
                    c('tunde_lag', 'Ours was smaller than expected because her dad crossed half the list off himself. Ask, some families are flexible.', 8),
                    c('lola_k', 'Keep the list. Every item. It helps when the wedding conversations start.', 4),
                ],
            },
        ],
    },
];
