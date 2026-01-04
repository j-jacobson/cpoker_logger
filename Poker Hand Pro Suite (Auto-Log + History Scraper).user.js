// ==UserScript==
// @name         Poker Hand Pro Suite (Auto-Log + History Scraper)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Captures live hands AND scrapes history in PokerStars format
// @author       Jonathan Jacobson
// @match        https://cpokers.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    // REPLACE THIS with your exact username on the site
    const MY_USERNAME = "Guest10388"; 
    // ---------------------

    const HAND_STORAGE = new Map(); // Stores hands by ID to prevent duplicates

    // --- PARSING ENGINE (Final Polish) ---
    function parseLogContainer(container) {
        const rawText = container.innerText;
        // HERO FILTER: Skip hand if "Dealt" line is missing
        if (!rawText.includes("Dealt")) return null;
        
        const idMatch = rawText.match(/Hand #(\d+)/);
        if (!idMatch) return null;
        const handId = idMatch[1];

        const isComplete = rawText.includes("Summary") || rawText.includes("collects") || rawText.includes("won");
        if (!isComplete) return null;

        let dateMatch = rawText.match(/Played at ([\d\-T:Z\.]+)/);
        let dateStr = dateMatch ? dateMatch[1] : new Date().toISOString();
        let cleanText = `PokerStars Hand #${handId}: Hold'em No Limit (1/2 USD) - ${dateStr}\n`;
        
        let heroLine = "";
        let bodyText = "";
        let boardCards = []; // We will use an array to store the full board

        let totalCalculatedPot = 0;
        
        const lines = container.querySelectorAll('.log-el');
        
        lines.forEach(el => {
            let line = el.innerText.replace(/\[B\]\s?/g, '').trim(); 

            if (line.includes("CPokers Hand") || line.includes("Button is in") || line.includes("Log Version")) return;

            if (line.startsWith("Dealt")) {
                let cards = line.replace("Dealt", "").replace("Preflop", "")
                                .replace(/♠/g, 's ').replace(/♥/g, 'h ').replace(/♦/g, 'd ').replace(/♣/g, 'c ')
                                .trim();
                heroLine = `Dealt to ${MY_USERNAME} [${cards}]\n`; 
                return; 
            }

            if (line.includes('Flop:') || line.includes('Turn:') || line.includes('River:')) {
                let parts = line.split(':');
                let street = parts[0].toUpperCase();
                let cardsRaw = parts[1].replace(/♠/g, 's ').replace(/♥/g, 'h ').replace(/♦/g, 'd ').replace(/♣/g, 'c ').trim();
                
                // Add these cards to our full board tracker
                cardsRaw.split(' ').filter(c => c.length > 0).forEach(card => {
                    if (!boardCards.includes(card)) boardCards.push(card);
                });

                line = `*** ${street} *** [${cardsRaw}]`;
            }

            line = line.replace('posts 1', 'posts small blind 1')
                       .replace('posts 2', 'posts big blind 2')
                       .replace('collects', 'won')
                       .replace('mucks', ' mucks')
            
            // Track all winnings to build an accurate Total Pot
            if (line.includes("won") && line.includes("from")) {
                let amountMatch = line.match(/won (\d+)/);
                if (amountMatch) totalCalculatedPot += parseInt(amountMatch[1]);
            }
            
            // FORMAT SHOWDOWN (Standardizes Guest10388:shows: A♥5♣)
            if (line.includes("shows")) {
                let parts = line.split("shows");
                let name = parts[0].trim();
                let cardsRaw = parts[1].split("(")[0] // Grabs just the A♥5♣ part
                                       .replace(/♠/g, 's ').replace(/♥/g, 'h ').replace(/♦/g, 'd ').replace(/♣/g, 'c ')
                                       .trim();
                line = `${name} shows [${cardsRaw}]`;
            }
            
            if (line.startsWith("SummaryTotal") || line.startsWith("Board")) return;

            bodyText += line + "\n";
        });

        // Build the Final Summary
        let summary = "*** SUMMARY ***\n";
        summary += `Total pot ${totalCalculatedPot} | Rake 0\n`;
        if (boardCards.length > 0) {
            summary += `Board [${boardCards.join(' ')}]\n`;
        }

        return { id: handId, text: cleanText + heroLine + bodyText + summary + "\n\n" };
    }
    
    // --- MODE 1: LIVE LISTENER ---
    // Checks the visible log every 2 seconds for new finished hands
    setInterval(() => {
        const container = document.querySelector('.log-container');
        if (container) {
            const result = parseLogContainer(container);
            if (result && !HAND_STORAGE.has(result.id)) {
                HAND_STORAGE.set(result.id, result.text);
                console.log(`[Auto-Log] Saved Hand #${result.id}`);
                updateButtonCount();
            }
        }
    }, 2000);

    // --- MODE 2: HISTORY SCRAPER ---
    // Automatically clicks "Back" to find old hands
    async function scrapeHistory() {
        const backBtn = document.querySelector('.log-back');
        const endBtn = document.querySelector('.log-end');
        const inputField = document.querySelector('.log-input');
        
        if (!backBtn) {
            alert("⚠️ Please open the 'Log' tab first so I can see the history buttons.");
            return;
        }

        const btn = document.getElementById('poker-download-btn');
        const originalText = btn.innerHTML;
        btn.innerHTML = "⏳ Scanning History...";
        btn.disabled = true;

        let lastIndex = -1;
        let noChangeCount = 0;

        // Loop until we hit the beginning (index 1) or the page stops changing
        while (true) {
            // 1. Parse currently visible hand
            const container = document.querySelector('.log-container');
            if (container) {
                const result = parseLogContainer(container);
                if (result) {
                    HAND_STORAGE.set(result.id, result.text);
                }
            }

            // 2. Check if we are at the start
            let currentIndex = inputField ? inputField.value : "0";
            if (currentIndex === "1" || currentIndex === lastIndex) {
                // Double check: sometimes the network is slow, give it a retry
                if(noChangeCount > 3) break; 
                noChangeCount++;
            } else {
                noChangeCount = 0;
            }
            lastIndex = currentIndex;

            // 3. Click Back
            backBtn.click();
            updateButtonCount();
            
            // 4. Wait a tiny bit for the new hand to load
            await new Promise(r => setTimeout(r, 100)); 
        }

        btn.innerHTML = originalText;
        btn.disabled = false;
        // 4. Click End
        endBtn.click();
        //alert(`Scrape Complete! I have captured ${HAND_STORAGE.size} unique hands.`);
        downloadHands();
    }

    // --- DOWNLOAD FUNCTION ---
    function downloadHands() {
        if (HAND_STORAGE.size === 0) {
            alert("No hands captured yet!");
            return;
        }
        
        // Sort hands by ID so they are in order
        const sortedHands = Array.from(HAND_STORAGE.values()).sort((a, b) => {
             const idA = a.match(/Hand #(\d+)/)[1];
             const idB = b.match(/Hand #(\d+)/)[1];
             return idA - idB;
        });

        const blob = new Blob([sortedHands.join("")], {type: 'text/plain'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `poker_session_${Date.now()}.txt`;
        a.click();
    }

    // --- UI: CONTROL PANEL ---
    function updateButtonCount() {
        const btn = document.getElementById('poker-download-btn');
        if(btn) btn.innerHTML = `💾 Download (${HAND_STORAGE.size} Hands)`;
    }

    const panel = document.createElement('div');
    panel.style = "position:fixed; bottom:10px; left:10px; z-index:10000; display:flex; gap:10px;";

    const downBtn = document.createElement('button');
    downBtn.id = 'poker-download-btn';
    downBtn.innerHTML = '💾 Download (0 Hands)';
    downBtn.style = "padding:10px 15px; background:#2ecc71; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;";
    downBtn.onclick = downloadHands;

    const scrapeBtn = document.createElement('button');
    scrapeBtn.innerHTML = '🔄 Fetch History';
    scrapeBtn.style = "padding:10px 15px; background:#e67e22; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;";
    scrapeBtn.onclick = scrapeHistory;

    panel.appendChild(scrapeBtn);
    panel.appendChild(downBtn);
    document.body.appendChild(panel);

})();
