from pyservice import worker
from pyservice.repo import find


def run():
    return worker.handle(find())
