"""Recette admin réelle sur fixtures MongoDB jetables, sans fournisseur externe."""
import json, sys
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

base, result_path, fixture_path, executable = sys.argv[1:]
fixtures = json.loads(Path(fixture_path).read_text())
out = Path(result_path).parent
out.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=15000)
checks = []
def checked(label):
    checks.append(label)
    print('OK — ' + label, flush=True)

def gql(page, query, variables=None, token=None):
    return page.evaluate('''async ({query, variables, token}) => {
      const r = await fetch('/api/delifast/graphql', {method:'POST',
        headers:{'content-type':'application/json', ...(token?{authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({query,variables:variables||{}})}); return r.json();
    }''', dict(query=query, variables=variables, token=token))

def success(page, query, variables=None, token=None):
    result = gql(page, query, variables, token)
    assert not result.get('errors'), result.get('errors')
    return result['data']

def login(page):
    page.goto(base + '/delifast')
    page.get_by_label('Email', exact=True).fill('admin@delifast.local')
    page.get_by_label('Mot de passe', exact=True).fill('AdminDemo!2026')
    page.get_by_role('button', name='Se connecter', exact=True).click()
    expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()

def capture(page, name):
    page.screenshot(path=str(out / name), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable or None,
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run'])
    external, errors = [], []
    context = browser.new_context(viewport={'width':1280,'height':900}, service_workers='block')
    def guard(route):
        url = route.request.url
        if urlsplit(url).scheme in ('data','blob') or url.startswith(base + '/'):
            route.continue_()
        else:
            external.append(url)
            route.abort('blockedbyclient')
    context.route('**/*', guard)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    login(page)
    admin = page.evaluate("sessionStorage.getItem('delifast-local-session')")
    assert admin
    ids = fixtures['orders']
    commands = page.get_by_role('region', name='Filtres commandes')
    filters = page.locator('section[aria-label="Filtres commandes"]')
    search = page.get_by_role('searchbox', name='Rechercher une commande')
    search.fill(ids[0])
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[1], exact=True)).to_have_count(0)
    search.fill('Fixture admin-acceptance-r1')
    filters.get_by_label('Paiement', exact=True).select_option('PAID')
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)).to_be_visible()
    search.fill('')
    filters.get_by_label('Restaurant', exact=True).select_option('rest-ouaga-centre')
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[1], exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)).to_have_count(0)
    page.get_by_role('button', name='Effacer les filtres', exact=True).click()
    checked('recherche et filtres combinés sur deux restaurants')
    link = page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)
    link.focus(); page.keyboard.press('Enter')
    detail = page.locator('aside[aria-label="Détail de la commande"]')
    expect(detail).to_be_visible()
    page.get_by_role('button', name='Passer à ACCEPTED', exact=True).click()
    expect(page.get_by_role('group', name='Confirmer le changement de commande', exact=True)).to_be_visible()
    before = success(page, '{operationsOrders{id status updatedAt}}', token=admin)['operationsOrders']
    assert next(o for o in before if o['id']==ids[0])['status']=='CONFIRMED'
    page.get_by_role('button', name='Confirmer le changement', exact=True).click()
    expect(detail.get_by_role('button', name='Passer à PREPARING', exact=True)).to_be_enabled()
    capture(page, 'order-accepted.png')
    detail.get_by_label('Livreur', exact=True).select_option('staff-rider')
    page.get_by_role('button', name='Affecter ce livreur', exact=True).click()
    expect(detail.get_by_text('Livreur affecté :', exact=False)).to_be_visible()
    checked('sélection clavier, confirmation commande et affectation explicite')
    # Le serveur accepte l’écriture mais sa réponse est perdue. Aucun rejeu automatique.
    lost = {'count':0}
    def lose_order(route):
        if 'transitionOrder(' in (route.request.post_data or ''):
            lost['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_order)
    page.get_by_role('button', name='Passer à PREPARING', exact=True).click()
    page.get_by_role('button', name='Confirmer le changement', exact=True).click()
    expect(detail.get_by_text('Résultat à vérifier.', exact=False)).to_be_visible()
    assert lost['count'] == 1
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', lose_order)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_enabled()
    checked('réponse commande perdue : état relu, action verrouillée et aucune double écriture')
    page.get_by_role('button', name='Support', exact=True).click()
    support = page.locator('section[aria-label="Support"]')
    expect(support.get_by_role('button', name='Recette support 1', exact=True)).to_be_visible()
    support.get_by_role('button', name='Suivante', exact=True).click()
    expect(support.get_by_text('Page 2', exact=False)).to_be_visible()
    support.get_by_role('button', name='Précédente', exact=True).click()
    support.get_by_role('button', name='Recette support 1', exact=True).click()
    ticket = support.locator('aside[aria-label="Détail du ticket"]')
    expect(ticket.get_by_text('Ticket fixture admin uniquement', exact=True)).to_be_visible()
    checked('Support paginé et détail serveur réel')
    mutation = 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id status version}}'
    # Modifier ailleurs pendant que l’admin lit version 0 : le brouillon doit échouer.
    success(page, mutation, {'id':'admin-ticket-a','v':0,'s':'IN_PROGRESS','n':'Prise en charge concurrente fictive'}, admin)
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Tentative sur version périmée')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True).click()
    expect(support.get_by_text('CONCURRENT_MODIFICATION', exact=False)).to_be_visible()
    expect(ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True)).to_be_disabled()
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Résolution de recette — visible au créateur')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à RESOLVED', exact=True).click()
    expect(support.get_by_text('Statut du ticket mis à jour.', exact=True)).to_be_visible()
    expect(ticket.get_by_text('Ce ticket est résolu', exact=False)).to_be_visible()
    owner = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-a'}, fixtures['restaurantToken'])['staffSupportTicket']
    assert owner['status']=='RESOLVED' and owner['version']==2
    assert owner['history'][-1]['note']=='Résolution de recette — visible au créateur'
    capture(page, 'support-resolved.png')
    checked('conflit Support, relecture obligatoire, résolution et note visible au créateur')
    for role_token in [None, fixtures['restaurantToken'], fixtures['riderToken']]:
        denied = gql(page, '{operationsSupportTickets(limit:20,offset:0){id}}', token=role_token)
        assert denied.get('errors')
        denied = gql(page, mutation, {'id':'admin-ticket-a','v':2,'s':'RESOLVED','n':'Interdit'}, role_token)
        assert denied.get('errors')
    assert success(page, 'query($id:ID!){staffSupportTicket(id:$id){id}}', {'id':'admin-ticket-a'}, fixtures['riderToken'])['staffSupportTicket'] is None
    checked('lecture et transition Support refusées hors ADMIN, isolation du créateur')
    support.get_by_role('button', name='Recette support 2', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True)).to_be_visible()
    lost_support = {'count':0}
    def lose_support(route):
        if 'transitionSupportTicket(' in (route.request.post_data or ''):
            lost_support['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_support)
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Prise en charge avec réponse perdue')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True).click()
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    assert lost_support['count']==1
    page.unroute('**/api/delifast/graphql', lose_support)
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    accepted = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-b'}, fixtures['riderToken'])['staffSupportTicket']
    assert accepted['status']=='IN_PROGRESS' and accepted['version']==1 and len(accepted['history'])==2
    expect(support.get_by_role('row').filter(has=page.get_by_role('button', name='Recette support 2', exact=True)).get_by_text('IN_PROGRESS', exact=True)).to_be_visible()
    checked('réponse Support perdue : un seul événement, verrouillage puis relecture explicite')
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'débordement horizontal global'
    capture(page, 'admin-support-390.png')
    page.get_by_role('button', name='Commandes', exact=True).click()
    page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True).click()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'débordement commandes'
    capture(page, 'admin-orders-390.png')
    page.get_by_role('button', name='Support', exact=True).click()
    support.get_by_role('button', name='Recette support 1', exact=True).click()
    expect(ticket.get_by_text('Ticket fixture admin uniquement', exact=True)).to_be_visible()
    page.get_by_role('button', name='Effacer les données / quitter', exact=True).click()
    expect(page.get_by_label('Email', exact=True)).to_be_visible()
    expect(page.get_by_text('Ticket fixture admin uniquement', exact=True)).to_have_count(0)
    assert page.evaluate("sessionStorage.getItem('delifast-local-session')") is None
    capture(page, 'admin-logout.png')
    checked('petit écran 390px sans débordement global et purge à la déconnexion')
    assert not external, external
    assert not errors, errors
    checked('aucune requête externe ni erreur JavaScript')
    Path(result_path).write_text(json.dumps({'checks':checks,'count':len(checks),'screenshots':[str(x) for x in out.glob('*.png')]}, ensure_ascii=False, indent=2)+'\n')
    browser.close()
