import numpy as np, json, re
def norm(s): return re.sub(r'[^a-z0-9]+',' ',str(s).lower()).strip()
s=np.load('scores.npz'); w3,dino,clip,color=s['w3'],s['dino'],s['clip'],s['color']
codes=json.load(open('codes.json'))
master=json.load(open('master.json'))
byfs={m['code'].replace('/','_'):m for m in master}
ci={c:i for i,c in enumerate(codes)}
judge=json.load(open('judge_scores.json'))                 # global idx(str)->0..100
jorder=json.load(open('judgeset_ordered.json'))            # [[i,j],...] global idx = position
n=len(codes)
final=np.zeros((n,n))
# 1) judged pairs: final = w3 + 0.20*(judge/100)
for gi_str,sc in judge.items():
    i,j=jorder[int(gi_str)]
    f=min(0.98, w3[i,j] + 0.20*(sc/100.0))
    final[i,j]=final[j,i]=f
# 2) near-duplicate pairs (same design/alt-code): treat as confirmed strong look-alike
for i in range(n):
    for j in range(i+1,n):
        if dino[i,j]>=0.95:
            f=min(0.98, w3[i,j] + 0.17)
            final[i,j]=final[j,i]=max(final[i,j],f)
CUT=0.70
# build per-panel alternatives (>=cutoff), sorted desc
sim={}
for i,ce in enumerate(codes):
    alts=[]
    for j in range(n):
        if j!=i and final[i,j]>=CUT:
            alts.append((codes[j], final[i,j]))
    alts.sort(key=lambda x:-x[1])
    m=byfs.get(ce,{})
    sim[m.get('code',ce)]={
        'name':m.get('name',''), 'alts':[{'code':byfs.get(c,{}).get('code',c),'name':byfs.get(c,{}).get('name',c),'pct':round(p*100)} for c,p in alts]
    }
json.dump(sim, open('similarity_partial.json','w'), indent=1)
withalt=sum(1 for k in sim if sim[k]['alts'])
allp=[a['pct'] for k in sim for a in sim[k]['alts']]
import numpy as _np
print(f'panels total: {n} | with >=1 alternative: {withalt} | unique panels: {len({k for k in sim if sim[k]["alts"]})}')
print(f'match% distribution: min {min(allp) if allp else 0} median {int(_np.median(allp)) if allp else 0} max {max(allp) if allp else 0} | total alt-links {len(allp)}')
print(f'judged pairs used: {len(judge)} | near-dupe pairs folded in')
