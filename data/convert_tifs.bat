REM python ./convert-tif-to-cog.py ./tif/bomen_3_rule_2026.tif --colors "#EBE4B1,#54B6C0"
REM python ./convert-tif-to-cog.py ./tif/bomen_30_rule_2026.tif --colors "#EBE4B1,#54B6C0"
REM python ./convert-tif-to-cog.py ./tif/bomen_300_rule_2026.tif --colors "#EBE4B1,#54B6C0"
REM python ./convert-tif-to-cog.py ./tif/bomen_3_30_300_rule_2026.tif --colors "#DADADA,#F1DD9B,#E9E4A9,#B1D2A5,#96C9B0,#71B8BE,#4496B3,#1E6299"

python ./convert-tif-to-cog.py .\tif/aandeel_aanpasbaar.tif --colors "#ffffff,#feebe2,#fcc5c0,#fa9fb6,#f768a6,#dd3497,#ae017d,#7a0177"
python ./convert-tif-to-cog.py .\tif/aandeel_ongeschikt.tif --colors "#ffffff,#fed7aa,#fec18a,#feac6b,#fb9c51,#f68738,#ef751f"
python ./convert-tif-to-cog.py .\tif/aandeel_geschikt.tif --colors "#ffffff,#c1d699,#acbf81,#98a86a,#829154,#707d41,#606b31"

REM loopafstanden
REM python ./convert-tif-to-cog.py .\tif/dagbesteding_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/ontmoeting_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/ziekenhuis_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/supermarkt_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/huisarts_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/ov_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/fysiotherapeut_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"
REM python ./convert-tif-to-cog.py .\tif/apotheek_lb_m5.tif --colors "#61BE7B,#A0D392,#FDEAB6,#F8D8AF,#FFAF92,#FF6024"

REM pandkenmerken
REM python ./convert-tif-to-cog.py .\tif/bouwjaar_lb_m5.tif --priority "1,2,3,4,5,6,7,8,9,10" 
REM --colors "#ffffff,#a50026,#d73027,#f46d43,#fdae61,#fee08b,#d9ef8b,#a6d96a,#66bd63,#1a9850,#006837"
REM python ./convert-tif-to-cog.py .\tif/pandtype_lb_m5.tif --priority "1,2,3,4,5" 
REM --colors "#ffffff,#1A9850,#A6D96A,#6464FF,#FFFF00,#FF3232"